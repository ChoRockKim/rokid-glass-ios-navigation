// 안경 메뉴 "버스·지하철 시간": 길안내와 상관없이 지금 위치에서 가장 가까운 버스 정류장과 지하철역의 실시간 도착.
// 버스: 서울 정류소정보조회(getStationByPos → getStationByUid, 정류장의 모든 노선)
// 지하철: 카카오 카테고리 검색(SW8)으로 가까운 역 → 서울 실시간 지하철(realtimeStationArrival, 역의 모든 열차)
import { searchCategory } from "./kakao.js";
import { getText, parseEta, shortSubwayMsg, stationName, SUBWAY_IDS, xmlItems } from "./realtime.js";

export interface NearbyBoard {
  kind: "bus" | "subway";
  /** 정류장·역 이름 */
  name: string;
  /** 내 위치에서 m */
  distance: number | null;
  /** 노선(지하철은 "1호선 청량리행")별 도착 두 개까지, 빨리 오는 순 */
  lines: { line: string; times: string[]; etas: (number | null)[] }[];
  /** 못 가져왔으면 이유 */
  error?: string;
}

export interface NearbyMessage {
  type: "nearby";
  boards: NearbyBoard[];
  note?: string;
}

const BUS_RADIUS_M = 300;
const SUBWAY_RADIUS_M = 800;

const when = (sec: number | null, msg: string) =>
  sec === null ? msg.replace(/\[.*?\]/g, "").trim() || msg : sec <= 60 ? "곧 도착" : `${Math.ceil(sec / 60)}분`;

/** 같은 노선끼리 모아 빨리 오는 노선부터 */
/** exact = sec 가 실제 남은 초 (어림값이 아님) → 안경이 줄여 보여 줄 수 있음 */
function group(rows: { line: string; sec: number | null; text: string; exact?: boolean }[], max = 12) {
  const by = new Map<string, { first: number; times: string[]; etas: (number | null)[] }>();
  for (const r of [...rows].sort((a, b) => (a.sec ?? 1e9) - (b.sec ?? 1e9))) {
    const g = by.get(r.line) ?? { first: r.sec ?? 1e9, times: [], etas: [] };
    if (g.times.length < 2) {
      g.times.push(r.text);
      g.etas.push(r.exact ? r.sec : null);
    }
    by.set(r.line, g);
  }
  return [...by].sort((a, b) => a[1].first - b[1].first).slice(0, max).map(([line, g]) => ({ line, times: g.times, etas: g.etas }));
}

const short = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  if (/ 401/.test(m)) return "API 키 확인 필요 (401)";
  if (/오류 주입/.test(m)) return "실시간 정보 없음 (오류 주입)";
  if (/Timeout|AbortError|fetch failed|ECONN|ETIMEDOUT|UND_ERR| 5\d\d/.test(m)) return "서버 응답 없음";
  return m.slice(0, 60);
};

export async function busBoard(lon: number, lat: number, key: string, base = "http://ws.bus.go.kr/api/rest"): Promise<NearbyBoard | null> {
  const items = async (path: string, params: Record<string, string>) => {
    const text = await getText(`${base}/${path}?serviceKey=${key}&${new URLSearchParams({ ...params, resultType: "json" })}`);
    return text.trim().startsWith("{") ? ((JSON.parse(text).msgBody?.itemList ?? []) as Record<string, string>[]) : xmlItems(text, "itemList");
  };
  const stops = await items("stationinfo/getStationByPos", { tmX: String(lon), tmY: String(lat), radius: String(BUS_RADIUS_M) });
  const near = [...stops].sort((a, b) => Number(a.dist ?? 1e9) - Number(b.dist ?? 1e9))[0];
  if (!near?.arsId) return null;
  const list = await items("stationinfo/getStationByUid", { arsId: String(near.arsId) });
  const rows = list.flatMap((x) =>
    [x.arrmsg1, x.arrmsg2]
      .filter((m): m is string => Boolean(m) && !/운행종료|출발대기/.test(String(m)))
      .map((m) => ({ line: String(x.rtNm ?? ""), sec: parseEta(m), text: when(parseEta(m), m), exact: parseEta(m) !== null })),
  );
  return { kind: "bus", name: String(near.stationNm ?? ""), distance: near.dist ? Math.round(Number(near.dist)) : null, lines: group(rows) };
}

export async function subwayBoard(lon: number, lat: number, kakaoKey: string, key: string, base = "http://swopenapi.seoul.go.kr"): Promise<NearbyBoard | null> {
  const [st] = await searchCategory("SW8", lon, lat, SUBWAY_RADIUS_M, kakaoKey);
  if (!st) return null;
  // "회기역 1호선" → "회기"
  const station = stationName(st.name.split(" ")[0] ?? st.name);
  const text = await getText(`${base}/api/subway/${encodeURIComponent(key)}/json/realtimeStationArrival/0/30/${encodeURIComponent(station)}`);
  return { kind: "subway", name: `${station}역`, distance: st.distance, lines: subwayLines(text) };
}

/** realtimeStationArrival 응답 → 호선·방향별 도착 */
export function subwayLines(text: string): NearbyBoard["lines"] {
  const rows: Record<string, string>[] = text.trim().startsWith("{") ? ((JSON.parse(text).realtimeArrivalList ?? []) as Record<string, string>[]) : xmlItems(text, "row");
  const out = rows.map((x) => {
    const sec = Number(x.barvlDt);
    const msg = String(x.arvlMsg2 ?? "");
    const s = Number.isFinite(sec) && sec > 0 ? sec : parseEta(msg);
    const line = SUBWAY_IDS[String(x.subwayId)] ?? "지하철";
    const dir = String(x.trainLineNm ?? "").split(" - ")[0] ?? "";
    // 초가 없으면 "[2]번째 전역" → 역당 2분으로 어림잡아 정렬만 (표시는 "2역 전")
    const stops = msg.match(/\[(\d+)\]번째 전역/)?.[1];
    const order = s ?? (stops ? Number(stops) * 120 : null);
    return { line: `${line} ${dir}`.trim(), sec: order, text: s === null ? shortSubwayMsg(msg) : when(s, msg), exact: s !== null };
  });
  return group(out);
}

/** 지금 위치 주변 보드들 (가까운 버스 정류장 1곳, 지하철역 1곳). 한쪽이 실패해도 다른 쪽은 보여 준다 */
export async function nearbyBoards(
  pos: { lon: number; lat: number } | null,
  keys: { kakao: string; bus?: string; subway?: string },
  log?: (m: string) => void,
): Promise<NearbyMessage> {
  if (!pos) return { type: "nearby", boards: [], note: "현재 위치 없음 (Overland 확인)" };
  const jobs: Promise<NearbyBoard | null>[] = [];
  if (keys.bus) jobs.push(busBoard(pos.lon, pos.lat, keys.bus).catch((e) => ({ kind: "bus", name: "버스", distance: null, lines: [], error: short(e) }) as NearbyBoard));
  if (keys.subway) jobs.push(subwayBoard(pos.lon, pos.lat, keys.kakao, keys.subway).catch((e) => ({ kind: "subway", name: "지하철", distance: null, lines: [], error: short(e) }) as NearbyBoard));
  const boards = (await Promise.all(jobs)).filter((b): b is NearbyBoard => b !== null);
  log?.(`nearby: ${boards.map((b) => `${b.name} ${b.lines.length}노선${b.error ? ` (${b.error})` : ""}`).join(" | ") || "없음"}`);
  return { type: "nearby", boards, note: boards.length ? undefined : `주변 ${SUBWAY_RADIUS_M}m 안에 정류장·역 없음` };
}
