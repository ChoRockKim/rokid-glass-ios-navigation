// 진행 상태. 개인용이라 활성 경로는 하나만 둔다.
// 진행은 두 가지로 바뀐다: 수동(안경 탭, /route next) 과 위치(POST /location).
import type { LonLat, Place, WalkRoute } from "./kakao.js";
import { buildGuide, formatDistance, line2For, type GuideStep, type Turn } from "./guide.js";
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
  route: WalkRoute; // 카카오 원본 (단계 그대로)
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
    }
  | { type: "arrived"; destination: string; text: string }
  | { type: "idle"; text: string };

/** 안경에서 받는 메시지 */
export type GlassInput = { type: "next" } | { type: "prev" } | { type: "sync" };

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

export function messageFor(active: ActiveRoute | null): GlassMessage {
  if (!active) return { type: "idle", text: "경로 없음 · Slack에서 /route" };
  const { guide, index, to } = active;
  const step = guide[index];
  if (!step) return { type: "arrived", destination: to.name, text: `도착: ${to.name}` };
  const remaining = remainingOf(active);
  const line1 = active.offRoute ? "⚠ 경로를 벗어났습니다" : step.line1;
  const line2 = remaining === null ? step.line2 : line2For(step, remaining);
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

  /** force=false 면 직전과 같은 내용(남은 거리는 10m 단위)은 보내지 않는다. 안경 화면 깜빡임 방지 */
  private emit(force = true) {
    const msg = messageFor(this.active);
    const key = JSON.stringify(
      msg.type === "step" ? { ...msg, remaining: msg.remaining === null ? null : Math.round(msg.remaining / 10), line2: undefined, text: undefined } : msg,
    );
    if (!force && key === this.lastEmitted) return;
    this.lastEmitted = key;
    for (const fn of this.listeners) fn(msg);
  }

  start(r: { from: Place; to: Place; route: WalkRoute; startedBy: string }) {
    const guide = buildGuide(r.route.steps);
    this.active = {
      ...r,
      guide,
      index: 0,
      tracker: new RouteTracker(guide),
      progress: null,
      offRoute: false,
      offRouteCount: 0,
      lastPosition: null,
      manualHold: null,
    };
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
    this.emit();
  }

  stop() {
    this.active = null;
    this.emit();
  }

  snapshot(): GlassMessage {
    return messageFor(this.active);
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
