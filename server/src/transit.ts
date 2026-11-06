// 카카오 대중교통 후보 → 고른 경로를 안경용 단계로.
// 카카오 대중교통 응답에는 출발지→첫 정류장, 마지막 정류장→도착지 도보가 없어서 도보 API 로 채운다.
import { searchStops, transitRoutes, walkRoute, type LonLat, type Place, type TransitLeg, type TransitRoute, type WalkRoute } from "./kakao.js";
import { buildGuide, formatDistance, line2For, type GuideStep } from "./guide.js";
import { resolvePair, type ChoosePlace, type PlaceInput } from "./planner.js";
import { distanceM, distToLine } from "./guide.js";
import { StopCache } from "./stopcache.js";

export interface TransitPlan {
  from: Place;
  to: Place;
  options: TransitRoute[];
  landingUrl?: string;
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩";
const MAX_OPTIONS = 5;
/** 이보다 짧은 앞뒤 도보는 붙이지 않는다 */
const MIN_WALK_M = 30;

export async function planTransit(from: PlaceInput, to: PlaceInput, key: string, choose?: ChoosePlace): Promise<TransitPlan> {
  const [f, t] = await resolvePair(from, to, key, choose);
  const { routes, landingUrl } = await transitRoutes(f, t, key);
  // 카카오 순서를 존중하되 시간순으로 상위 몇 개만
  const options = [...routes].sort((a, b) => a.totalTime - b.totalTime).slice(0, MAX_OPTIONS);
  return { from: f, to: t, options, landingUrl };
}

const rides = (r: TransitRoute) => r.legs.filter((l) => l.kind !== "WALKING");

function rideLabel(l: TransitLeg): string {
  const name = l.kind === "BUS" ? `${l.lines.slice(0, 2).join("/")}${l.lines.length > 2 ? ` 외 ${l.lines.length - 2}` : ""}번` : l.lines[0] ?? "지하철";
  return `${name} ${l.stops[0] ?? ""}→${l.stops[l.stops.length - 1] ?? ""}`;
}

/** Slack/단축어용 한 줄 요약 */
export function summarizeOption(r: TransitRoute, i: number): string {
  const head = `${CIRCLED[i] ?? `${i + 1}.`} ${Math.round(r.totalTime / 60)}분 · 환승 ${r.transfers}${r.fare ? ` · ${r.fare.toLocaleString("ko-KR")}원` : ""}`;
  return `${head}  ${rides(r).map(rideLabel).join(" / ")}`;
}

/** 안경 선택 화면용 카드 (네이버 지도처럼 총 시간 + 구간 막대) */
export interface RouteCard {
  minutes: number;
  transfers: number;
  fare: number | null;
  walkMinutes: number;
  legs: { kind: "walk" | "bus" | "subway"; minutes: number; label: string; board: string }[];
}

export function routeCard(r: TransitRoute): RouteCard {
  const min = (s: number) => Math.max(1, Math.round(s / 60));
  return {
    minutes: min(r.totalTime),
    transfers: r.transfers,
    fare: r.fare,
    walkMinutes: Math.round(r.legs.filter((l) => l.kind === "WALKING").reduce((t, l) => t + l.time, 0) / 60),
    legs: r.legs.map((l) => ({
      kind: l.kind === "WALKING" ? "walk" : l.kind === "BUS" ? "bus" : "subway",
      minutes: min(l.time),
      // 버스는 "120번" 처럼 번호에 "번"을 붙인다 (막대 안에서 시간과 헷갈리지 않게)
      label: l.kind === "WALKING" ? "" : l.kind === "BUS" ? `${l.lines[0] ? `${l.lines[0]}번` : "버스"}${l.lines.length > 1 ? ` 외 ${l.lines.length - 1}` : ""}` : (l.lines[0] ?? "지하철"),
      board: l.kind === "WALKING" ? "" : (l.stops[0] ?? ""),
    })),
  };
}

/** 단축어가 읽어 줄 짧은 문장 */
export function speakOption(r: TransitRoute, i: number): string {
  return `${i + 1}번, ${Math.round(r.totalTime / 60)}분, ${rides(r)
    .map((l) => (l.kind === "BUS" ? `${l.lines[0]}번 버스` : l.lines[0]))
    .join(" 타고 ")}`;
}

/** "제기역약령시장제기역약령시장정류장까지 도보로 이동 (3번 출구)" 처럼 이름이 겹쳐 나오는 문구에서 출구 정보만 뽑는다 */
function exitOf(guidance: string): string | null {
  return guidance.match(/\((\d+번 출구)\)/)?.[1] ?? null;
}

function walkLegStep(l: TransitLeg, next: TransitLeg | undefined): GuideStep {
  const isTransfer = /환승/.test(l.guidance);
  const target = next?.stops[0] ?? l.stops[l.stops.length - 1] ?? null;
  const exit = exitOf(l.guidance);
  const line1 = isTransfer ? `[도보] ${l.stops[0] ?? ""} 환승` : `[도보] ${target ?? ""}까지 도보${exit ? ` · ${exit}` : ""}`;
  return {
    turn: "walk",
    angle: null,
    at: l.stops[0] ?? null,
    target,
    road: null,
    distance: l.distance,
    time: l.time,
    crossings: 0,
    line1,
    line2: line2For({ target, road: null }, l.distance),
    raw: [l.guidance],
    points: l.points,
  };
}

export function rideStep(l: TransitLeg): GuideStep {
  const kind = l.kind === "BUS" ? "bus" : "subway";
  const board = l.stops[0] ?? "";
  const alight = l.stops[l.stops.length - 1] ?? "";
  const lines = l.lines.length ? l.lines : [l.guidance.split(" (")[0] ?? ""];
  const icon = kind === "bus" ? "[버스]" : "[지하철]";
  return {
    turn: kind,
    angle: null,
    at: board,
    target: alight,
    road: null,
    distance: l.distance,
    time: l.time,
    crossings: 0,
    line1: `${icon} ${lines.slice(0, 3).join("/")} 탑승 · ${board}`,
    line2: `${alight} 하차 · ${Math.max(1, l.stops.length - 1)}정거장`,
    raw: [l.guidance],
    points: l.points,
    ride: { kind, lines, board, alight, stops: l.stops, boardPoint: l.points[0] ?? null, live: null, liveAt: null },
  };
}

const placeAt = (p: LonLat, name: string): Place => ({ name, address: "", x: p[0], y: p[1] });

/** 앞뒤 도보를 카카오 도보 API 로 채운다. 실패하거나 짧으면 생략 */
async function walkBetween(a: Place, b: Place, key: string): Promise<WalkRoute | null> {
  if (distanceM([a.x, a.y], [b.x, b.y]) < MIN_WALK_M) return null;
  try {
    return await walkRoute(a, b, key);
  } catch {
    return null;
  }
}

export async function buildTransitGuide(plan: TransitPlan, option: TransitRoute, key: string): Promise<{ guide: GuideStep[]; route: WalkRoute }> {
  const legs = option.legs;
  const firstRide = legs.find((l) => l.kind !== "WALKING");
  const lastRide = [...legs].reverse().find((l) => l.kind !== "WALKING");
  const guide: GuideStep[] = [];

  // 출발지 → 첫 탑승지 (카카오가 첫 도보를 안 줄 때만)
  if (legs[0]?.kind !== "WALKING" && firstRide?.points[0]) {
    const w = await walkBetween(plan.from, placeAt(firstRide.points[0], firstRide.stops[0] ?? "탑승지"), key);
    if (w) {
      const g = buildGuide(w.steps);
      if (g[0]) g[0].line1 = `[도보] ${firstRide.stops[0] ?? ""}까지 도보`;
      guide.push(...g);
    }
  }

  legs.forEach((l, i) => guide.push(l.kind === "WALKING" ? walkLegStep(l, legs[i + 1]) : rideStep(l)));

  // 마지막 하차지 → 도착지
  const lastPoint = lastRide?.points[lastRide.points.length - 1];
  if (legs[legs.length - 1]?.kind !== "WALKING" && lastPoint) {
    const w = await walkBetween(placeAt(lastPoint, lastRide?.stops[lastRide.stops.length - 1] ?? "하차지"), plan.to, key);
    if (w) {
      const g = buildGuide(w.steps);
      if (g[0]) {
        g[0].turn = "walk";
        g[0].line1 = `[도보] ${lastRide?.stops[lastRide.stops.length - 1] ?? ""}에서 도보`;
      }
      guide.push(...g);
    }
  }

  const totalDistance = guide.reduce((t, s) => t + s.distance, 0);
  const totalTime = guide.reduce((t, s) => t + s.time, 0);
  return { guide, route: { totalDistance, totalTime: Math.max(totalTime, option.totalTime), landingUrl: plan.landingUrl, steps: [] } };
}

export { formatDistance };

// 마지막으로 보여 준 후보 (개인용이라 하나만). Slack 과 API 가 같이 쓴다.
let pending: TransitPlan | null = null;
export const pendingTransit = {
  get: () => pending,
  set: (p: TransitPlan | null) => {
    pending = p;
  },
};

/** 후보 i 를 골라 안경 안내를 시작할 준비 */
export async function selectTransit(i: number, key: string) {
  const plan = pending;
  if (!plan) throw new Error("먼저 대중교통 후보를 조회하세요.");
  const option = plan.options[i];
  if (!option) throw new Error(`후보 번호는 1~${plan.options.length} 입니다.`);
  const { guide, route } = await buildTransitGuide(plan, option, key);
  return { plan, option, guide, route };
}

/**
 * Navigator.stopLocator: 구간의 정류장마다 카카오에서 위치 후보를 찾아, 경로선에 가장 가까운 것을 고른다.
 * 탑승·하차는 경로선 양끝. 가운데 정류장은 경로선 위 비율 지점 근처에서 찾는다 (같은 이름의 반대편 정류장이 있어도 경로선에 붙은 쪽)
 */
export function kakaoStopLocator(
  key: string,
  log: (m: string) => void,
  routeStops?: (ride: { stops: string[]; lines: string[] }, points: LonLat[]) => Promise<({ lon: number; lat: number } | null)[] | null>,
  cache?: StopCache,
  /** 서울 정류소정보조회로 경로선 주변 정류장의 실제 좌표 (노선정보가 안 될 때) */
  alongStops?: (ride: { stops: string[] }, points: LonLat[]) => Promise<({ lon: number; lat: number } | null)[] | null>,
) {
  return async (ride: { kind: "bus" | "subway"; stops: string[]; lines: string[] }, points: LonLat[]): Promise<({ lon: number; lat: number } | null)[]> => {
    if (points.length < 2) return ride.stops.map(() => null);
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1]! + distanceM(points[i - 1]!, points[i]!));
    const total = cum[cum.length - 1]!;
    const at = (f: number): LonLat => {
      const t = f * total;
      const i = Math.max(1, cum.findIndex((c) => c >= t));
      const seg = cum[i]! - cum[i - 1]! || 1;
      const k = (t - cum[i - 1]!) / seg;
      return [points[i - 1]![0] + (points[i]![0] - points[i - 1]![0]) * k, points[i - 1]![1] + (points[i]![1] - points[i - 1]![1]) * k];
    };
    // 경로선까지 거리: 선분까지 (꼭짓점까지로 재면 긴 직선 구간에서 멀게 나와 다 버려졌다, 2026-11-06)
    const offset = (p: LonLat) => distToLine(p, points);
    const n = ride.stops.length;
    const out: ({ lon: number; lat: number } | null)[] = [];
    let ok = 0;
    // 기억해 둔 위치 (가운데 정류장 전부 있으면 아무것도 안 부른다)
    const line = ride.lines[0] ?? "";
    const keyOf = (k: number) => StopCache.key(ride.kind, line, ride.stops[k]!);
    const remembered = ride.stops.map((_, k) => (k === 0 || k === n - 1 ? undefined : cache?.get(keyOf(k))));
    // 어림 위치(카카오)만 기억하고 있으면 정확한 위치를 먼저 다시 찾아 본다
    const allRemembered = n > 2 && remembered.slice(1, -1).every((x, i) => x !== undefined && !cache?.isApprox(keyOf(i + 1)));
    // 서울 버스는 노선 정류장 목록(정확한 좌표)부터. 안 되면(키에 노선정보조회가 없거나 한도) 카카오로
    let exact = ride.kind === "bus" && routeStops && !allRemembered ? await routeStops(ride, points).catch((e) => (log(`stops 노선정보조회 실패: ${e instanceof Error ? e.message : String(e)}`), null)) : null;
    let source = exact ? "노선정보" : "";
    if (!exact && ride.kind === "bus" && alongStops && !allRemembered) {
      exact = await alongStops(ride, points).catch((e) => (log(`stops 정류소정보조회 실패: ${e instanceof Error ? e.message : String(e)}`), null));
      if (exact) source = "정류소정보";
    }
    let fromCache = 0;
    for (let k = 0; k < n; k++) {
      if (k === 0 || k === n - 1) {
        const p = k === 0 ? points[0]! : points[points.length - 1]!;
        out.push({ lon: p[0], lat: p[1] });
        ok++;
        continue;
      }
      const mem = remembered[k];
      const known = exact?.[k];
      if (known) { out.push(known); ok++; cache?.set(keyOf(k), [known.lon, known.lat]); continue; }
      if (mem !== undefined) {
        out.push(mem ? { lon: mem[0], lat: mem[1] } : null);
        if (mem) ok++;
        fromCache++;
        continue;
      }
      try {
        const name = ride.stops[k]!;
        // "청계벽산아파트.텐즈힐아파트" 처럼 두 이름이면 앞 이름도
        const queries = [name, ...(name.includes(".") ? [name.split(".")[0]!] : [])];
        let best: { c: LonLat; d: number } | undefined;
        for (const q of queries) {
          const cands = await searchStops(q, ride.kind, at(k / (n - 1)), key);
          best = cands.map((c) => ({ c, d: offset(c) })).filter((x) => x.d <= 150).sort((x, y) => x.d - y.d)[0];
          if (best) break;
        }
        out.push(best ? { lon: best.c[0], lat: best.c[1] } : null);
        if (best) ok++;
        cache?.set(keyOf(k), best ? best.c : null, !!best && ride.kind === "bus");
      } catch {
        out.push(null); // 오류는 기억하지 않음 (다음에 다시)
      }
    }
    cache?.flush();
    log(`stops ${ride.lines.slice(0, 2).join("/")}: ${ok}/${n} 찾음${source ? ` (${source})` : ""}${fromCache ? ` (기억 ${fromCache})` : ""}${ok < n ? ` (못 찾음: ${ride.stops.filter((_, i) => !out[i]).slice(0, 4).join(", ")})` : ""}`);
    return out;
  };
}
