// 위치 → 경로 위 진행 거리(s). 경로를 하나의 선(polyline)으로 펴고, 현재 위치를 가장 가까운 선분에 수직 투영한다.
// 짧은 거리라 위경도를 현지 평면 좌표(m)로 근사한다.
import type { LonLat } from "./kakao.js";
import type { GuideStep } from "./guide.js";

export interface Projection {
  s: number; // 출발점부터 경로를 따라 온 거리 (m)
  offset: number; // 경로선까지 수직 거리 (m)
}

type XY = [number, number];

export class RouteTracker {
  private readonly lon0: number;
  private readonly lat0: number;
  private readonly kx: number;
  private readonly ky = 110_540;
  private readonly xy: XY[] = [];
  private readonly cum: number[] = []; // 각 점까지 누적 거리
  readonly stepStart: number[] = [];
  readonly stepEnd: number[] = [];

  constructor(steps: Pick<GuideStep, "points">[]) {
    const first = steps.find((s) => s.points.length)?.points[0] ?? [0, 0];
    this.lon0 = first[0];
    this.lat0 = first[1];
    this.kx = 111_320 * Math.cos((this.lat0 * Math.PI) / 180);

    let total = 0;
    for (const step of steps) {
      this.stepStart.push(total);
      for (const p of step.points) {
        const q = this.toXY(p);
        const last = this.xy[this.xy.length - 1];
        if (last) {
          const d = Math.hypot(q[0] - last[0], q[1] - last[1]);
          if (d < 0.01) continue; // 단계 경계의 중복 점
          total += d;
        }
        this.xy.push(q);
        this.cum.push(total);
      }
      this.stepEnd.push(total);
    }
  }

  get length() {
    return this.cum[this.cum.length - 1] ?? 0;
  }

  private toXY([lon, lat]: LonLat): XY {
    return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky];
  }

  /**
   * 가장 가까운 선분에 투영. near 가 주어지면 [near-50, near+400] 구간을 먼저 보고,
   * 거기서 너무 멀면(35m+) 전체에서 다시 찾는다. 경로가 되돌아오는 곳에서 엉뚱한 쪽으로 튀는 걸 줄인다.
   */
  project(p: LonLat, near?: number): Projection | null {
    if (this.xy.length < 2) return null;
    const q = this.toXY(p);
    const search = (lo: number, hi: number) => {
      let best: Projection | null = null;
      for (let i = 1; i < this.xy.length; i++) {
        if (this.cum[i]! < lo || this.cum[i - 1]! > hi) continue;
        const a = this.xy[i - 1]!;
        const b = this.xy[i]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2)) : 0;
        const px = a[0] + t * dx;
        const py = a[1] + t * dy;
        const offset = Math.hypot(q[0] - px, q[1] - py);
        if (!best || offset < best.offset) best = { s: this.cum[i - 1]! + t * Math.sqrt(len2), offset };
      }
      return best;
    };
    if (near !== undefined) {
      const local = search(near - 50, near + 400);
      if (local && local.offset <= 35) return local;
      const global = search(-Infinity, Infinity);
      if (local && global && global.offset >= local.offset - 5) return local;
      return global;
    }
    return search(-Infinity, Infinity);
  }

  /** 진행 거리 s 지점의 좌표(경도, 위도)와 진행 방위(도, 북=0, 시계방향) */
  pointAt(s: number): { lon: number; lat: number; heading: number } | null {
    if (this.xy.length < 2) return null;
    const t = Math.max(0, Math.min(s, this.length));
    let i = 1;
    while (i < this.xy.length - 1 && this.cum[i]! < t) i++;
    const a = this.xy[i - 1]!;
    const b = this.xy[i]!;
    const seg = this.cum[i]! - this.cum[i - 1]!;
    const f = seg > 0 ? (t - this.cum[i - 1]!) / seg : 0;
    const x = a[0] + (b[0] - a[0]) * f;
    const y = a[1] + (b[1] - a[1]) * f;
    const heading = ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360;
    return { lon: x / this.kx + this.lon0, lat: y / this.ky + this.lat0, heading };
  }

  /** 진행 거리 s 에서 보여 줄 단계: 끝까지 advanceM 보다 많이 남은 첫 단계. 다 지났으면 steps.length (도착) */
  stepAt(s: number, advanceM: number | ((i: number) => number)): number {
    const adv = typeof advanceM === "number" ? () => advanceM : advanceM;
    const i = this.stepEnd.findIndex((end, k) => end - s > adv(k));
    return i === -1 ? this.stepEnd.length : i;
  }
}
