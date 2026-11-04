// 진행 상태. 개인용이라 활성 경로는 하나만 둔다.
import type { Place, WalkRoute } from "./kakao.js";

export interface ActiveRoute {
  from: Place;
  to: Place;
  route: WalkRoute;
  index: number;
  startedBy: string; // Slack user id
}

/** 안경으로 보내는 메시지. 안경은 text 한 줄만 표시하면 된다. */
export type GlassMessage =
  | { type: "step"; index: number; total: number; text: string; distance: number; destination: string }
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

export function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

export function formatMinutes(s: number): string {
  return `${Math.max(1, Math.round(s / 60))}분`;
}

export function messageFor(active: ActiveRoute | null): GlassMessage {
  if (!active) return { type: "idle", text: "경로 없음 · Slack에서 /route" };
  const { route, index, to } = active;
  const step = route.steps[index];
  if (!step) return { type: "arrived", destination: to.name, text: `도착: ${to.name}` };
  return {
    type: "step",
    index,
    total: route.steps.length,
    text: step.guidance,
    distance: step.distance,
    destination: to.name,
  };
}

export class Navigator {
  private active: ActiveRoute | null = null;
  private listeners = new Set<(msg: GlassMessage) => void>();

  get current() {
    return this.active;
  }

  onChange(fn: (msg: GlassMessage) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const msg = messageFor(this.active);
    for (const fn of this.listeners) fn(msg);
  }

  start(r: ActiveRoute) {
    this.active = { ...r, index: 0 };
    this.emit();
  }

  /** index는 steps.length 까지 갈 수 있다 (= 도착) */
  move(delta: number) {
    if (!this.active) return;
    const max = this.active.route.steps.length;
    this.active.index = Math.min(max, Math.max(0, this.active.index + delta));
    this.emit();
  }

  stop() {
    this.active = null;
    this.emit();
  }

  snapshot(): GlassMessage {
    return messageFor(this.active);
  }
}
