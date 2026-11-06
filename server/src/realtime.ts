// 실시간 도착 폴링.
// 다음에 탈 버스·지하철(현재 단계 또는 바로 다음 단계, 아직 안 탄 것)의 도착 정보를 POLL_MS 마다 가져와 안경에 갱신한다.
//
// ⚠ 서울 지하철·버스 API 명세는 이 세션에서 직접 호출해 보지 못했다 (키 없음 + 도메인 차단).
//   공개 자료 기준으로 쓴 것이라, 키를 받으면 scripts/probe-realtime.ts 로 실제 응답을 보고 맞춰야 한다.
//   응답이 JSON 이든 XML 이든 읽도록 관대하게 파싱한다.
import { fetch } from "undici";
import { dispatcher } from "./proxy.js";
import { faultOn, InjectedFault } from "./faults.js";
import type { Arrival, GuideStep, RideInfo } from "./guide.js";
import type { Navigator } from "./navigation.js";
import { distanceM, distToLine } from "./guide.js";

export interface ArrivalProvider {
  name: string;
  supports(ride: RideInfo): boolean;
  fetch(ride: RideInfo): Promise<Arrival[]>;
}

export async function getText(url: string): Promise<string> {
  if (faultOn("realtime")) throw new InjectedFault("realtime");
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), dispatcher });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

/**
 * 공공데이터포털(서울 버스) 일일 호출 한도. 개발계정은 하루 횟수가 정해져 있어 넘으면
 * 401 "유효하지 않은 서비스키입니다: 서비스 요청제한 횟수 초과 에러" (2026-11-06 실서버 로그에서 확인).
 * 한 번 넘으면 다음 날 0시(한국 시간)까지 부르지 않는다 (계속 두드려 봐야 같은 오류)
 */
export class QuotaError extends Error {}
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
export const nextKstMidnight = (now: number) => Math.floor((now + KST_MS) / DAY_MS + 1) * DAY_MS - KST_MS;
const isQuota = (text: string) => /요청제한 횟수 초과|LIMITED_NUMBER_OF_SERVICE_REQUESTS/.test(text);
const busQuota = { blockedUntil: 0, day: 0, calls: 0 };

/** 오늘(한국 시간) 버스 API 를 부른 횟수와 막힘 여부 (/status·로그용) */
export function busUsage(now = Date.now()) {
  return { calls: Math.floor((now + KST_MS) / DAY_MS) === busQuota.day ? busQuota.calls : 0, blockedUntil: busQuota.blockedUntil > now ? busQuota.blockedUntil : null };
}
export function resetBusQuota() {
  Object.assign(busQuota, { blockedUntil: 0, day: 0, calls: 0 });
}

/** 버스 API 호출 (한도를 넘었으면 부르지 않고 QuotaError) */
export async function busGet(url: string, now = Date.now): Promise<string> {
  if (now() < busQuota.blockedUntil) throw new QuotaError("오늘 버스 조회 한도 초과");
  const day = Math.floor((now() + KST_MS) / DAY_MS);
  if (day !== busQuota.day) Object.assign(busQuota, { day, calls: 0 });
  busQuota.calls++;
  let text: string;
  try {
    text = await getText(url);
  } catch (e) {
    if (!isQuota(e instanceof Error ? e.message : String(e))) throw e;
    text = "LIMITED_NUMBER_OF_SERVICE_REQUESTS";
  }
  // 200 으로 오류 XML 을 줄 때도 있다
  if (text.length < 2000 && isQuota(text)) {
    busQuota.blockedUntil = nextKstMidnight(now());
    throw new QuotaError(`오늘 버스 조회 한도 초과 (오늘 ${busQuota.calls}번 호출)`);
  }
  return text;
}

/** <itemList><a>1</a><b>x</b></itemList> 반복을 객체 배열로. 단순한 XML 응답용 */
export function xmlItems(xml: string, tag: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const m of xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))) {
    const item: Record<string, string> = {};
    for (const f of m[1]!.matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) item[f[1]!] = f[2]!.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    out.push(item);
  }
  return out;
}

/** "왕십리(성동구청)" → "왕십리", "청량리(서울시립대입구)" → "청량리" */
export function stationName(name: string): string {
  return name.replace(/\(.*?\)/g, "").replace(/역$/, "").trim();
}

/** 지하철 arvlMsg2 를 안경용으로 줄인다. "[6]번째 전역 (창동)" → "6역 전" (2026-11-04 실제 응답 문구) */
export function shortSubwayMsg(msg: string): string {
  const n = msg.match(/\[(\d+)\]번째 전역/);
  if (n) return `${n[1]}역 전`;
  if (/전역 도착/.test(msg)) return "전역 도착";
  if (/전역 출발/.test(msg)) return "전역 출발";
  if (/진입/.test(msg)) return "진입 중";
  if (/도착/.test(msg)) return "도착";
  if (/출발/.test(msg)) return "출발";
  return msg.replace(/\s*\(.*?\)\s*/g, "").trim();
}

/** "3분12초후[2번째 전]" → 192, "곧 도착" → 0, 그 외 null */
export function parseEta(msg: string): number | null {
  if (/곧 ?도착|전역 ?도착|도착$|진입/.test(msg)) return 0;
  const m = msg.match(/(?:(\d+)분)?\s*(?:(\d+)초)?\s*후/);
  if (m && (m[1] || m[2])) return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  return null;
}

// ── 서울 지하철 실시간 도착 (서울 열린데이터광장 realtimeStationArrival) ──
// 공개 자료 기준 필드: subwayId, trainLineNm("청량리행 - 회기방면"), barvlDt(초), arvlMsg2, statnNm
export const SUBWAY_IDS: Record<string, string> = {
  "1001": "1호선", "1002": "2호선", "1003": "3호선", "1004": "4호선", "1005": "5호선", "1006": "6호선",
  "1007": "7호선", "1008": "8호선", "1009": "9호선", "1063": "경의중앙선", "1065": "공항철도", "1067": "경춘선",
  "1075": "수인분당선", "1077": "신분당선", "1092": "우이신설선", "1093": "서해선", "1081": "경강선", "1032": "GTX-A",
};

/** 결과가 비었을 때 원인을 볼 수 있게 응답 요약을 남긴다 (키는 URL 에만 있고 로그에 안 남긴다) */
type DebugLog = (m: string) => void;

export function subwayProvider(key: string, base = "http://swopenapi.seoul.go.kr", debug?: DebugLog): ArrivalProvider {
  return {
    name: "seoul-subway",
    supports: (r) => r.kind === "subway",
    async fetch(r) {
      const station = stationName(r.board);
      const text = await getText(`${base}/api/subway/${encodeURIComponent(key)}/json/realtimeStationArrival/0/20/${encodeURIComponent(station)}`);
      const rows: Record<string, string>[] = text.trim().startsWith("{")
        ? ((JSON.parse(text).realtimeArrivalList ?? []) as Record<string, string>[])
        : xmlItems(text, "row");
      const next = r.stops[1] ? stationName(r.stops[1]) : null;
      // 역의 모든 열차를 돌려주고, 내가 탈 노선·방향만 mine (안경 간소 화면에서 나머지는 약하게 보여 준다)
      const result = rows.map((x) => {
        const line = SUBWAY_IDS[String(x.subwayId)] ?? "";
        const lineOk = !r.lines.length || r.lines.some((l) => line && l.includes(line.replace("선", "")));
        // 진행 방향: "…행 - {다음역}방면"
        const dirOk = !next || String(x.trainLineNm ?? "").includes(`${next}방면`);
        const sec = Number(x.barvlDt);
        const msg = String(x.arvlMsg2 ?? "");
        return {
          line: line || r.lines[0] || "지하철",
          etaSec: Number.isFinite(sec) && sec > 0 ? sec : parseEta(msg),
          message: shortSubwayMsg(msg),
          direction: String(x.trainLineNm ?? ""),
          mine: lineOk && dirOk,
        };
      });
      if (!result.some((a) => a.mine) && debug) {
        const err = text.split(key).join("***").replace(/\s+/g, " ").slice(0, 300);
        debug(
          `subway debug ${station}: rows=${rows.length} want lines=${r.lines.join("/")} next=${next ?? "-"} head=${err} sample=${JSON.stringify(
            rows.slice(0, 4).map((x) => [x.subwayId, x.trainLineNm, x.arvlMsg2, x.barvlDt]),
          )}`,
        );
      }
      return result;
    },
  };
}

// ── 서울 버스 도착 (공공데이터포털 서울특별시 정류소정보·버스도착정보) ──
// 공개 자료 기준: stationinfo/getStationByPos(tmX=경도,tmY=위도,radius) → arsId, stationNm
//                 stationinfo/getStationByUid(arsId) → rtNm, arrmsg1, arrmsg2
export function seoulBusProvider(key: string, base = "http://ws.bus.go.kr/api/rest", debug?: DebugLog): ArrivalProvider {
  const arsCache = new Map<string, string>(); // "lon,lat" → arsId

  async function items(path: string, params: Record<string, string>) {
    const q = new URLSearchParams({ ...params, resultType: "json" });
    // data.go.kr 키는 이미 인코딩된 형태로 줄 때가 있어 serviceKey 는 그대로 붙인다
    const text = await busGet(`${base}/${path}?serviceKey=${key}&${q}`);
    const list = text.trim().startsWith("{") ? ((JSON.parse(text).msgBody?.itemList ?? []) as Record<string, string>[]) : xmlItems(text, "itemList");
    if (!list.length) debug?.(`bus debug ${path}: empty, head=${text.replace(/serviceKey=[^&"<]+/g, "serviceKey=***").slice(0, 300)}`);
    return list;
  }

  async function arsIdFor(r: RideInfo): Promise<string | null> {
    if (!r.boardPoint) return null;
    const k = r.boardPoint.join(",");
    if (arsCache.has(k)) return arsCache.get(k)!;
    const list = await items("stationinfo/getStationByPos", { tmX: String(r.boardPoint[0]), tmY: String(r.boardPoint[1]), radius: "150" });
    const want = stationName(r.board).replace(/\s|\./g, "");
    const hit =
      list.find((s) => String(s.stationNm ?? "").replace(/\s|\./g, "") === want) ??
      [...list].sort((a, b) => Number(a.dist ?? 1e9) - Number(b.dist ?? 1e9))[0];
    const ars = hit?.arsId ? String(hit.arsId) : null;
    if (ars) arsCache.set(k, ars);
    return ars;
  }

  return {
    name: "seoul-bus",
    supports: (r) => r.kind === "bus",
    async fetch(r) {
      const ars = await arsIdFor(r);
      if (!ars) return [];
      const list = await items("stationinfo/getStationByUid", { arsId: ars });
      // 정류장의 모든 버스를 돌려주고, 내가 탈 노선만 mine (안경 간소 화면에서 나머지는 약하게 보여 준다)
      const wanted = new Set(r.lines.map((l) => l.replace(/번$/, "")));
      return list.flatMap((x) =>
        [x.arrmsg1, x.arrmsg2]
          .filter((m): m is string => Boolean(m) && !/운행종료|출발대기/.test(String(m)))
          .map((m) => ({ line: String(x.rtNm ?? ""), etaSec: parseEta(m), message: m, mine: !wanted.size || wanted.has(String(x.rtNm ?? "")) })),
      );
    },
  };
}

/** 실시간 실패 → 안경에 보여 줄 짧은 이유 */
export function realtimeReason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (e instanceof QuotaError) return "오늘 버스 조회 한도 초과 (자정에 풀림)";
  if (/ 401|키|key/i.test(m)) return "실시간 정보 없음 (API 키 확인 필요)";
  if (/오류 주입/.test(m)) return "실시간 정보 없음 (오류 주입)";
  if (/Timeout|AbortError|fetch failed|ECONN|ETIMEDOUT|UND_ERR| 5\d\d/.test(m)) return "실시간 정보 없음 (서버 응답 없음)";
  return "실시간 정보 없음";
}

export const POLL_MS = Number(process.env.REALTIME_POLL_MS ?? 20_000);
/** 버스는 정류장 근처에서도 1분마다 (도착 정보가 분 단위, 버스 API 는 하루 한도가 빠듯함) */
export const BUS_POLL_MS = 60_000;
/**
 * 탈 정류장에서 멀면 덜 자주 부른다 (2026-11-06: 정류장과 상관없이 20초마다 불러 버스 API 하루 한도를 다 씀).
 * 500m 안 20초(버스는 1분), 2km 안 1분, 더 멀면 3분. 위치가 10분 넘게 안 오면(폰이 위치를 안 보냄 = 안 쓰는 중) 5분
 */
export function pollInterval(nav: Navigator, ride: RideInfo, now = Date.now()): number {
  const p = nav.lastKnownPosition;
  if (!p || (p.ts !== undefined && now - p.ts > 10 * 60_000)) return 5 * 60_000;
  const near = ride.kind === "bus" ? BUS_POLL_MS : POLL_MS;
  if (!ride.boardPoint) return near;
  const d = distanceM([p.lon, p.lat], ride.boardPoint);
  return d <= 500 ? near : d <= 2000 ? 60_000 : 180_000;
}
const FAIL_BACKOFF_MS = 120_000;

/** 길안내 중이고 안경을 보고 있을 때만, 다음 탑승 구간을 주기적으로 조회한다. 탈 게 없으면 아무것도 안 부른다 */
/**
 * watching: 안경 앱이 켜져 서버에 붙어 있는지. 꺼져 있으면 아무도 안 보니 부르지 않는다
 * (2026-11-06: 아침에 시작한 경로가 남아 있는 동안 안경을 안 쓰는데도 계속 조회)
 */
export function startRealtimePoller(nav: Navigator, providers: ArrivalProvider[], log: (m: string) => void, watching: () => boolean = () => true) {
  if (!providers.length) {
    log("실시간 도착: 키가 없어 꺼짐 (SEOUL_SUBWAY_KEY, DATA_GO_KR_KEY)");
    return () => {};
  }
  log(`실시간 도착: ${providers.map((p) => p.name).join(", ")} · ${POLL_MS / 1000}s 간격`);
  let busy = false;
  let lastStep: GuideStep | null = null;
  let lastAt = 0;
  let quotaLogged = false;

  const tick = async () => {
    const up = nav.upcomingRide();
    if (!up?.step.ride || busy || !watching()) return;
    // 새 탑승 구간이면 바로, 아니면 POLL_MS 마다
    if (up.step === lastStep && Date.now() - lastAt < pollInterval(nav, up.step.ride)) return;
    const provider = providers.find((p) => p.supports(up.step.ride!));
    if (!provider) return;
    busy = true;
    lastStep = up.step;
    lastAt = Date.now();
    try {
      const arrivals = await provider.fetch(up.step.ride);
      nav.setArrivals(up.step, arrivals);
      log(`realtime ${provider.name} ${up.step.ride.board}: ${arrivals.filter((a) => a.mine !== false).slice(0, 3).map((a) => `${a.line} ${a.message} eta=${a.etaSec ?? "-"}`).join(" | ") || "없음"}`);
    } catch (e) {
      // 키 미활성 등으로 계속 실패할 때 20초마다 두드리지 않도록 잠시 쉰다 (한도 초과면 busGet 이 자정까지 부르지 않음)
      lastAt = Date.now() + FAIL_BACKOFF_MS - POLL_MS;
      if (!(e instanceof QuotaError) || !quotaLogged) log(`realtime ${provider.name} 실패 (${FAIL_BACKOFF_MS / 1000}s 뒤 재시도): ${e instanceof Error ? e.message : String(e)}`);
      quotaLogged = e instanceof QuotaError;
      // 안경에 이유를 알린다 (정보가 그냥 사라지지 않게)
      nav.setArrivalsError(up.step, realtimeReason(e));
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 1000);
  return () => clearInterval(timer);
}

export function providersFromEnv(debug?: DebugLog): ArrivalProvider[] {
  const out: ArrivalProvider[] = [];
  if (process.env.SEOUL_SUBWAY_KEY) out.push(subwayProvider(process.env.SEOUL_SUBWAY_KEY, undefined, debug));
  if (process.env.DATA_GO_KR_KEY) out.push(seoulBusProvider(process.env.DATA_GO_KR_KEY, undefined, debug));
  return out;
}

/**
 * 서울 버스 노선의 정류장 좌표 (공공데이터포털 서울특별시_노선정보조회: getBusRouteList → getStaionByRoute).
 * 탑승 정류장(경로선 시작에 가장 가까운 같은 이름)부터 노선 순서대로 하차까지 이름을 맞춰 좌표를 준다.
 * 노선마다 2번 부르고 기억한다. 키에 이 API 활용 신청이 안 돼 있으면 빈 목록 → null (카카오로 대신).
 * ⚠ 공개 자료 기준으로 쓴 것. 실제 응답은 실서버 로그(stops … (노선정보))로 확인
 */
export function seoulRouteStops(key: string, base = "http://ws.bus.go.kr/api/rest", debug?: DebugLog) {
  const cache = new Map<string, Record<string, string>[]>();
  async function items(path: string, params: Record<string, string>) {
    const q = new URLSearchParams({ ...params, resultType: "json" });
    const text = await busGet(`${base}/${path}?serviceKey=${key}&${q}`);
    const list = text.trim().startsWith("{") ? ((JSON.parse(text).msgBody?.itemList ?? []) as Record<string, string>[]) : xmlItems(text, "itemList");
    if (!list.length) debug?.(`bus route debug ${path}: empty, head=${text.replace(/serviceKey=[^&"<]+/g, "serviceKey=***").slice(0, 200)}`);
    return list;
  }
  const flat = (t: string) => String(t ?? "").replace(/[\s.·()]/g, "");
  return async (ride: { stops: string[]; lines: string[] }, points: [number, number][]): Promise<({ lon: number; lat: number } | null)[] | null> => {
    const line = ride.lines.map((l) => l.replace(/번$/, "")).find(Boolean);
    if (!line || ride.stops.length < 2 || !points.length) return null;
    let stations = cache.get(line);
    if (!stations) {
      const routes = await items("busRouteInfo/getBusRouteList", { strSrch: line });
      const r = routes.find((x) => String(x.busRouteNm) === line);
      if (!r?.busRouteId) return null;
      stations = (await items("busRouteInfo/getStaionByRoute", { busRouteId: String(r.busRouteId) })).filter((s) => s.gpsX && s.gpsY);
      if (!stations.length) return null;
      cache.set(line, stations);
    }
    const pos = (s: Record<string, string>): [number, number] => [Number(s.gpsX), Number(s.gpsY)];
    const board = stations
      .map((s, i) => ({ s, i }))
      .filter((x) => flat(x.s.stationNm!) === flat(ride.stops[0]!))
      .sort((a, b) => distanceM(pos(a.s), points[0]!) - distanceM(pos(b.s), points[0]!))[0];
    if (!board) return null;
    const out: ({ lon: number; lat: number } | null)[] = ride.stops.map(() => null);
    let j = board.i;
    out[0] = { lon: pos(board.s)[0], lat: pos(board.s)[1] };
    for (let k = 1; k < ride.stops.length; k++) {
      // 다음 몇 정류장 안에서 같은 이름 (회차 지점에서 순서가 이어지도록 노선 끝을 넘으면 처음으로)
      for (let step = 1; step <= 6; step++) {
        const idx = (j + step) % stations.length;
        if (flat(stations[idx]!.stationNm!) === flat(ride.stops[k]!)) {
          const p = pos(stations[idx]!);
          out[k] = { lon: p[0], lat: p[1] };
          j = idx;
          break;
        }
      }
    }
    return out;
  };
}

/**
 * 서울 버스 정류장 실제 좌표를 정류소정보조회(getStationByPos, 이미 쓰는 API)로: 버스 경로선을 따라 SAMPLE_M 마다
 * 반경 RADIUS_M 안 정류장을 받아 이름으로 맞춘다. 같은 이름이 여럿이면(길 건너 반대 방향) 경로선에 가까운 쪽.
 * 구간 길이 5km 면 약 9번. 찾은 건 StopCache 가 기억하므로 같은 노선 정류장은 처음 한 번만
 */
export function seoulStopsAlong(key: string, base = "http://ws.bus.go.kr/api/rest") {
  const SAMPLE_M = 600;
  const RADIUS_M = 400;
  const flat = (t: string) => String(t ?? "").replace(/[\s.·()]/g, "");
  return async (ride: { stops: string[] }, points: [number, number][]): Promise<({ lon: number; lat: number } | null)[] | null> => {
    if (points.length < 2 || ride.stops.length < 3) return null;
    const samples: [number, number][] = [points[0]!];
    let acc = 0;
    for (let i = 1; i < points.length; i++) {
      acc += distanceM(points[i - 1]!, points[i]!);
      if (acc >= SAMPLE_M) { samples.push(points[i]!); acc = 0; }
    }
    samples.push(points[points.length - 1]!);
    const found = new Map<string, [number, number][]>();
    for (const s of samples) {
      const q = new URLSearchParams({ tmX: String(s[0]), tmY: String(s[1]), radius: String(RADIUS_M), resultType: "json" });
      const text = await busGet(`${base}/stationinfo/getStationByPos?serviceKey=${key}&${q}`);
      const list = text.trim().startsWith("{") ? ((JSON.parse(text).msgBody?.itemList ?? []) as Record<string, string>[]) : xmlItems(text, "itemList");
      for (const x of list) {
        if (!x.stationNm || !x.gpsX || !x.gpsY) continue;
        const k = flat(x.stationNm);
        found.set(k, [...(found.get(k) ?? []), [Number(x.gpsX), Number(x.gpsY)]]);
      }
    }
    const near = (p: [number, number]) => distToLine(p, points);
    return ride.stops.map((name, k) => {
      if (k === 0 || k === ride.stops.length - 1) return null;
      const c = (found.get(flat(name)) ?? []).sort((a, b) => near(a) - near(b))[0];
      return c ? { lon: c[0], lat: c[1] } : null;
    });
  };
}
