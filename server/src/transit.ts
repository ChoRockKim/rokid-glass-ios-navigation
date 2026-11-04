// 카카오 대중교통 후보 → 고른 경로를 안경용 단계로.
// 카카오 대중교통 응답에는 출발지→첫 정류장, 마지막 정류장→도착지 도보가 없어서 도보 API 로 채운다.
import { transitRoutes, walkRoute, type LonLat, type Place, type TransitLeg, type TransitRoute, type WalkRoute } from "./kakao.js";
import { buildGuide, formatDistance, line2For, type GuideStep } from "./guide.js";
import { resolvePair, type ChoosePlace, type PlaceInput } from "./planner.js";
import { distanceM } from "./guide.js";

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
      label: l.kind === "WALKING" ? "" : l.kind === "BUS" ? `${l.lines[0] ?? "버스"}${l.lines.length > 1 ? ` 외 ${l.lines.length - 1}` : ""}` : (l.lines[0] ?? "지하철"),
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
