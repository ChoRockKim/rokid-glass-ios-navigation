// 진행 상태. 개인용이라 활성 경로는 하나만 둔다.
// 진행은 두 가지로 바뀐다: 수동(안경 탭, /route next) 과 위치(POST /location).
import type { LonLat, Place, WalkRoute } from "./kakao.js";
import { buildGuide, formatDistance, line2For, type Arrival, type GuideStep, type Turn } from "./guide.js";
import { RouteTracker } from "./tracking.js";

export { formatDistance };

/** 다음 회전 지점까지 이만큼 남으면 다음 단계를 보여 준다 */
export const ADVANCE_M = 12;
/** 경로선에서 이만큼 벗어나면 이탈 (정확도가 나쁘면 acc*1.5 까지 허용) */
export const OFF_ROUTE_M = 35;
/** 정확도가 이보다 나쁜 위치는 버린다 */
export const MAX_ACCURACY_M = 60;
/** 수동으로 넘긴 뒤 이 시간 동안은 위치가 단계를 되돌리지 못한다 */
const MANUAL_HOLD_MS = 60_000;

export interface Position {
  lon: number;
  lat: number;
  acc?: number; // m
  ts?: number; // epoch ms
}

export interface ActiveRoute {
  from: Place;
  to: Place;
  mode: "walk" | "transit";
  route: WalkRoute; // 카카오 도보 원본 (대중교통이면 steps 는 비어 있고 합계만)
  guide: GuideStep[]; // 안경용으로 합친 단계
  index: number; // guide 기준
  startedBy: string; // Slack user id 또는 "api"
  tracker: RouteTracker;
  progress: number | null; // 위치 추적 중이면 경로 위 진행 거리(m)
  offRoute: boolean;
  offRouteCount: number; // 연속 이탈 횟수
  lastPosition: Position | null;
  manualHold: { index: number; until: number } | null;
}

/** 안경으로 보내는 메시지. 한 줄만 쓰는 클라이언트는 text, 두 줄이면 line1/line2. */
export type GlassMessage =
  | {
      type: "step";
      index: number;
      total: number;
      turn: Turn;
      line1: string;
      line2: string;
      text: string;
      distance: number; // 이 단계 전체 거리
      remaining: number | null; // 위치 추적 중일 때 이 단계 끝까지 남은 거리
      offRoute: boolean;
      destination: string;
      ride?: {
        kind: "bus" | "subway";
        lines: string[];
        board: string;
        alight: string;
        boarded: boolean;
        stopsLeft: number;
        arrivals: Arrival[];
      };
    }
  | { type: "arrived"; destination: string; text: string }
  | { type: "idle"; text: string };

/** 미니맵용 메시지 (안경 화면 배경). 경로는 시작할 때 한 번, 위치는 바뀔 때마다 */
export type MapMessage =
  | {
      type: "map-route";
      segments: { kind: "walk" | "bus" | "subway"; points: [number, number][] }[];
      turns: [number, number][]; // 각 단계 시작점 (단계 index 와 같은 순서)
    }
  | { type: "map-pos"; lon: number; lat: number; heading: number; snapped: boolean; next: number | null }
  | { type: "map-roads"; lines: [number, number][][]; major: boolean[] };

/** 안경에서 받는 메시지 */
export type GlassInput =
  | { type: "next" }
  | { type: "prev" }
  | { type: "sync" }
  /** 안경 앱이 navigator.geolocation 으로 받은 위치 (AIUI). 출처(안경/폰)는 미확인 */
  | { type: "position"; lat: number; lon: number; acc?: number; ts?: number };

/** `강남역 > 선릉역`, `강남역 -> 선릉역`, `강남역 → 선릉역`, `강남역에서 선릉역` */
export function parseRouteArgs(text: string): { from: string; to: string } | null {
  const t = text.trim();
  const m = t.match(/^(.+?)\s*(?:->|→|>)\s*(.+)$/) ?? t.match(/^(.+?)에서\s+(.+?)(?:까지)?$/);
  if (!m?.[1] || !m[2]) return null;
  return { from: m[1].trim(), to: m[2].trim() };
}

export function formatMinutes(s: number): string {
  return `${Math.max(1, Math.round(s / 60))}분`;
}

function remainingOf(a: ActiveRoute): number | null {
  if (a.progress === null || a.index >= a.guide.length) return null;
  return Math.max(0, a.tracker.stepEnd[a.index]! - a.progress);
}

/** 탑승으로 볼 진행 거리 (정류장에서 이만큼 지나면 탄 것으로 본다) */
const BOARDED_M = 80;
/** 이보다 오래된 실시간 정보는 안 쓴다 */
const LIVE_MAX_AGE_MS = 90_000;

export function arrivalText(x: Arrival): string {
  if (x.etaSec === null) return `${x.line} ${x.message}`;
  if (x.etaSec <= 60) return `${x.line} 곧 도착`;
  return `${x.line} ${Math.ceil(x.etaSec / 60)}분 후`;
}

/** 두 대가 같은 노선이면 "421 4분 · 10분 후" 처럼 합친다 */
export function arrivalsText(xs: Arrival[]): string {
  const [a, b] = xs;
  if (!a) return "";
  if (!b) return arrivalText(a);
  if (a.line === b.line && a.etaSec !== null && b.etaSec !== null && a.etaSec > 60) {
    return `${a.line} ${Math.ceil(a.etaSec / 60)}분 · ${Math.ceil(b.etaSec / 60)}분 후`;
  }
  if (a.line === b.line) return `${arrivalText(a)} · ${arrivalText(b).slice(a.line.length + 1)}`;
  return `${arrivalText(a)} · ${arrivalText(b)}`;
}

function rideView(a: ActiveRoute, step: GuideStep, now: number) {
  const r = step.ride!;
  const start = a.tracker.stepStart[a.index] ?? 0;
  const len = Math.max(1, (a.tracker.stepEnd[a.index] ?? start) - start);
  const into = a.progress === null ? 0 : a.progress - start;
  const boarded = into > BOARDED_M;
  const remaining = remainingOf(a) ?? step.distance;
  const stopsTotal = Math.max(1, r.stops.length - 1);
  // 정류장 좌표가 없어 거리 비율로 추정한다
  const stopsLeft = boarded ? Math.max(1, Math.ceil((stopsTotal * remaining) / len)) : stopsTotal;
  const icon = r.kind === "bus" ? "[버스]" : "[지하철]";
  const name = r.lines.slice(0, 3).join("/");
  const fresh = r.live && r.liveAt !== null && now - r.liveAt < LIVE_MAX_AGE_MS;
  const arrivals = fresh ? [...r.live!].sort((x, y) => (x.etaSec ?? 1e9) - (y.etaSec ?? 1e9)) : [];
  const line1 = boarded
    ? `${icon} ${name} 탑승 중`
    : arrivals.length
      ? `${icon} ${arrivalsText(arrivals.slice(0, 2))}`
      : `${icon} ${name} 탑승 · ${r.board}`;
  const line2 = boarded ? `${r.alight} 하차 · 약 ${stopsLeft}정거장` : `${r.board} → ${r.alight} · ${stopsTotal}정거장`;
  return {
    line1,
    line2,
    ride: { kind: r.kind, lines: r.lines, board: r.board, alight: r.alight, boarded, stopsLeft, arrivals },
  };
}

export function messageFor(active: ActiveRoute | null, now = Date.now()): GlassMessage {
  if (!active) return { type: "idle", text: "경로 없음" };
  const { guide, index, to } = active;
  const step = guide[index];
  if (!step) return { type: "arrived", destination: to.name, text: `도착: ${to.name}` };
  const remaining = remainingOf(active);
  const rv = step.ride ? rideView(active, step, now) : null;
  const line1 = active.offRoute ? "[이탈] 경로를 벗어났습니다" : (rv?.line1 ?? step.line1);
  const line2 = rv?.line2 ?? (remaining === null ? step.line2 : line2For(step, remaining));
  return {
    type: "step",
    index,
    total: guide.length,
    turn: step.turn,
    line1,
    line2,
    text: `${line1} · ${line2}`,
    distance: step.distance,
    remaining,
    offRoute: active.offRoute,
    destination: to.name,
    ...(rv ? { ride: rv.ride } : {}),
  };
}

export interface PositionResult {
  accepted: boolean;
  reason?: "no-route" | "inaccurate" | "stale";
  progress?: number;
  offset?: number;
  offRoute?: boolean;
  offRouteCount?: number;
  index?: number;
}

export class Navigator {
  private active: ActiveRoute | null = null;
  private listeners = new Set<(msg: GlassMessage) => void>();
  private mapListeners = new Set<(msg: MapMessage) => void>();
  private lastMapPos: MapMessage | null = null;
  private lastEmitted = "";
  /** 경로가 없을 때도 마지막 위치는 기억한다 (단축어 /route 에 출발지가 없을 때 사용) */
  lastKnownPosition: Position | null = null;

  constructor(private now: () => number = Date.now) {}

  get current() {
    return this.active;
  }

  onChange(fn: (msg: GlassMessage) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onMap(fn: (msg: MapMessage) => void) {
    this.mapListeners.add(fn);
    return () => this.mapListeners.delete(fn);
  }

  private emitMap(msg: MapMessage) {
    if (msg.type === "map-pos") this.lastMapPos = msg;
    for (const fn of this.mapListeners) fn(msg);
  }

  /** 지금 경로의 미니맵 데이터 (새로 연결한 화면에 보낼 것) */
  mapSnapshot(): MapMessage[] {
    const a = this.active;
    if (!a) return [];
    const out: MapMessage[] = [this.routeMap(a)];
    if (this.lastMapPos) out.push(this.lastMapPos);
    else {
      const p = a.tracker.pointAt(0);
      if (p) out.push({ type: "map-pos", ...p, snapped: true, next: a.index + 1 < a.guide.length ? a.index + 1 : null });
    }
    return out;
  }

  private routeMap(a: ActiveRoute): MapMessage {
    const q = (p: LonLat): [number, number] => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
    return {
      type: "map-route",
      segments: a.guide.map((g) => ({ kind: g.ride ? g.ride.kind : "walk", points: g.points.map(q) })),
      turns: a.guide.map((g) => q(g.points[0] ?? [0, 0])),
    };
  }

  /** 진행 거리 기준 내 위치·방향을 미니맵에 알린다. 이탈 중이면 실제 위치 */
  private emitPos(a: ActiveRoute, raw: Position | null) {
    const next = a.index + 1 < a.guide.length ? a.index + 1 : null;
    if (!a.offRoute && a.progress !== null) {
      const p = a.tracker.pointAt(a.progress);
      if (p) return this.emitMap({ type: "map-pos", ...p, snapped: true, next });
    }
    if (raw) {
      const heading = (this.lastMapPos?.type === "map-pos" ? this.lastMapPos.heading : 0);
      this.emitMap({ type: "map-pos", lon: raw.lon, lat: raw.lat, heading, snapped: false, next });
    }
  }

  /** force=false 면 직전과 같은 내용(남은 거리는 10m 단위)은 보내지 않는다. 안경 화면 깜빡임 방지 */
  private emit(force = true) {
    const msg = messageFor(this.active, this.now());
    const key = JSON.stringify(
      msg.type === "step" ? { ...msg, remaining: msg.remaining === null ? null : Math.round(msg.remaining / 10), line2: undefined, text: undefined } : msg,
    );
    if (!force && key === this.lastEmitted) return;
    this.lastEmitted = key;
    for (const fn of this.listeners) fn(msg);
  }

  /** guide 를 주면 그대로 쓴다 (대중교통). 없으면 도보 경로에서 만든다 */
  start(r: { from: Place; to: Place; route: WalkRoute; startedBy: string; guide?: GuideStep[]; mode?: "walk" | "transit" }) {
    const guide = r.guide ?? buildGuide(r.route.steps);
    this.active = {
      from: r.from,
      to: r.to,
      route: r.route,
      startedBy: r.startedBy,
      mode: r.mode ?? "walk",
      guide,
      index: 0,
      tracker: new RouteTracker(guide),
      progress: null,
      offRoute: false,
      offRouteCount: 0,
      lastPosition: null,
      manualHold: null,
    };
    this.lastMapPos = null;
    this.emitMap(this.routeMap(this.active));
    const p0 = this.active.tracker.pointAt(0);
    if (p0) this.emitMap({ type: "map-pos", ...p0, snapped: true, next: guide.length > 1 ? 1 : null });
    this.emit();
  }

  /** 재탐색: 목적지는 그대로, 경로만 바꾼다 */
  reroute(from: Place, route: WalkRoute) {
    if (!this.active) return;
    const { to, startedBy } = this.active;
    this.start({ from, to, route, startedBy });
  }

  /** index는 guide.length 까지 갈 수 있다 (= 도착) */
  move(delta: number) {
    const a = this.active;
    if (!a) return;
    a.index = Math.min(a.guide.length, Math.max(0, a.index + delta));
    if (a.progress !== null) {
      // 위치 추적 중이면 진행 거리도 그 단계 시작으로 맞추고, 잠시 위치가 되돌리지 못하게 한다
      a.progress = a.index < a.guide.length ? a.tracker.stepStart[a.index]! : a.tracker.length;
      a.manualHold = { index: a.index, until: this.now() + MANUAL_HOLD_MS };
    }
    a.offRoute = false;
    a.offRouteCount = 0;
    if (a.progress !== null) this.emitPos(a, null);
    else {
      const p = a.index < a.guide.length ? a.tracker.pointAt(a.tracker.stepStart[a.index] ?? 0) : null;
      if (p) this.emitMap({ type: "map-pos", ...p, snapped: true, next: a.index + 1 < a.guide.length ? a.index + 1 : null });
    }
    this.emit();
  }

  stop() {
    this.active = null;
    this.lastMapPos = null;
    this.emit();
  }

  snapshot(): GlassMessage {
    return messageFor(this.active, this.now());
  }

  /** 지금부터 처음 타게 될(아직 안 탄) 버스·지하철 (실시간 폴링 대상). 정류장까지 걷는 동안에도 미리 조회한다 */
  upcomingRide(): { index: number; step: GuideStep } | null {
    const a = this.active;
    if (!a) return null;
    for (let i = a.index; i < a.guide.length; i++) {
      const step = a.guide[i]!;
      if (!step.ride) continue;
      const start = a.tracker.stepStart[i] ?? 0;
      const boarded = i === a.index && a.progress !== null && a.progress - start > BOARDED_M;
      if (boarded) continue; // 지금 타고 있는 구간 다음의 탑승(환승)을 본다
      return { index: i, step };
    }
    return null;
  }

  /** 폴링 결과 반영. 경로가 바뀌었으면(step 이 더 이상 없으면) 무시 */
  setArrivals(step: GuideStep, arrivals: Arrival[]) {
    if (!step.ride || !this.active?.guide.includes(step)) return;
    step.ride.live = arrivals;
    step.ride.liveAt = this.now();
    this.emit(false);
  }

  /** 위치 여러 개를 시간순으로 반영하고 마지막에 한 번만 안경에 보낸다 */
  updatePositions(positions: Position[]): PositionResult {
    const sorted = [...positions].sort((x, y) => (x.ts ?? 0) - (y.ts ?? 0));
    let result: PositionResult = { accepted: false, reason: "no-route" };
    for (const p of sorted) result = this.apply(p);
    this.emit(false);
    return result;
  }

  private apply(p: Position): PositionResult {
    const prevTs = this.lastKnownPosition?.ts ?? 0;
    if (p.ts !== undefined && p.ts < prevTs) return { accepted: false, reason: "stale" };
    if (p.acc !== undefined && p.acc > MAX_ACCURACY_M) return { accepted: false, reason: "inaccurate" };
    this.lastKnownPosition = p;

    const a = this.active;
    if (!a) return { accepted: false, reason: "no-route" };
    a.lastPosition = p;

    const proj = a.tracker.project([p.lon, p.lat] as LonLat, a.progress ?? undefined);
    if (!proj) return { accepted: false, reason: "no-route" };

    const limit = Math.max(OFF_ROUTE_M, (p.acc ?? 0) * 1.5);
    a.offRoute = proj.offset > limit;
    a.offRouteCount = a.offRoute ? a.offRouteCount + 1 : 0;

    if (!a.offRoute) {
      a.progress = proj.s;
      let index = a.tracker.stepAt(proj.s, ADVANCE_M);
      if (a.manualHold) {
        if (this.now() < a.manualHold.until && index < a.manualHold.index) {
          index = a.manualHold.index;
          a.progress = Math.max(a.progress, a.tracker.stepStart[index] ?? a.progress);
        } else if (this.now() >= a.manualHold.until) {
          a.manualHold = null;
        }
      }
      a.index = index;
    }

    this.emitPos(a, p);
    return {
      accepted: true,
      progress: a.progress ?? undefined,
      offset: proj.offset,
      offRoute: a.offRoute,
      offRouteCount: a.offRouteCount,
      index: a.index,
    };
  }
}
