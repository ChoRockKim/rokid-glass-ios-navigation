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
    const text = await getText(`${base}/${path}?serviceKey=${key}&${q}`);
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
  if (/ 401|키|key/i.test(m)) return "실시간 정보 없음 (API 키 확인 필요)";
  if (/오류 주입/.test(m)) return "실시간 정보 없음 (오류 주입)";
  if (/Timeout|AbortError|fetch failed|ECONN|ETIMEDOUT|UND_ERR| 5\d\d/.test(m)) return "실시간 정보 없음 (서버 응답 없음)";
  return "실시간 정보 없음";
}

export const POLL_MS = Number(process.env.REALTIME_POLL_MS ?? 20_000);
const FAIL_BACKOFF_MS = 120_000;

/** 활성 경로의 다음 탑승 구간을 주기적으로 조회한다. 탈 게 없으면 아무것도 안 부른다 */
export function startRealtimePoller(nav: Navigator, providers: ArrivalProvider[], log: (m: string) => void) {
  if (!providers.length) {
    log("실시간 도착: 키가 없어 꺼짐 (SEOUL_SUBWAY_KEY, DATA_GO_KR_KEY)");
    return () => {};
  }
  log(`실시간 도착: ${providers.map((p) => p.name).join(", ")} · ${POLL_MS / 1000}s 간격`);
  let busy = false;
  let lastStep: GuideStep | null = null;
  let lastAt = 0;

  const tick = async () => {
    const up = nav.upcomingRide();
    if (!up?.step.ride || busy) return;
    // 새 탑승 구간이면 바로, 아니면 POLL_MS 마다
    if (up.step === lastStep && Date.now() - lastAt < POLL_MS) return;
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
      // 키 미활성 등으로 계속 실패할 때 20초마다 두드리지 않도록 잠시 쉰다
      lastAt = Date.now() + FAIL_BACKOFF_MS - POLL_MS;
      log(`realtime ${provider.name} 실패 (${FAIL_BACKOFF_MS / 1000}s 뒤 재시도): ${e instanceof Error ? e.message : String(e)}`);
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
