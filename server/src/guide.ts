// 카카오 도보 단계를 안경용 안내로 가공한다.
// 1) 횡단보도·교량 진입·50m 미만 같은 자잘한 단계를 다음 이동 단계에 합친다.
// 2) 경로 좌표로 회전 방향을 계산한다 (앞 구간 끝 40m vs 다음 구간 처음 40m 의 진행 방위).
// 카카오 문구에는 회전 방향이 거의 없어서 (가끔 "왼쪽길로") 좌표로 보완한다.
// 검증: 외대앞역→왕십리역 1건에서 카카오가 "왼쪽길로" 라고 쓴 두 곳이 계산 결과 좌회전(-73°, -94°)과 일치. 실지 확인은 안 됨.
import type { LonLat, Step } from "./kakao.js";

export type Turn = "start" | "straight" | "slight-left" | "slight-right" | "left" | "right" | "uturn";

export interface GuideStep {
  turn: Turn;
  angle: number | null; // 도, 오른쪽 +
  at: string | null; // 회전하는 곳 (예: 외국어대교차로)
  target: string | null; // 이 단계의 도착 지점 (예: 회기역앞교차로)
  road: string | null;
  distance: number; // m, 합친 단계 전체
  time: number; // s
  crossings: number; // 횡단보도 개수
  line1: string; // 안경 첫 줄: 방향
  line2: string; // 안경 둘째 줄: 어디까지 얼마나 (전체 거리 기준)
  raw: string[]; // 합쳐진 카카오 원문
  points: LonLat[]; // 이 단계 경로 좌표 (위치 추적용, 안경으로는 안 보냄)
}

/** 둘째 줄. 위치 추적 중이면 남은 거리로 다시 만든다. */
export function line2For(step: Pick<GuideStep, "target" | "road">, meters: number): string {
  return [`${step.target ? `${step.target}까지 ` : ""}${formatDistance(meters)}`, step.road ?? ""].filter(Boolean).join(" · ");
}

const MIN_STEP_M = 50;
const BEARING_SAMPLE_M = 40;

const R = 6371000;
const rad = Math.PI / 180;

export function distanceM(p: LonLat, q: LonLat): number {
  const dLat = (q[1] - p[1]) * rad;
  const dLon = (q[0] - p[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p[1] * rad) * Math.cos(q[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearing(p: LonLat, q: LonLat): number {
  const y = Math.sin((q[0] - p[0]) * rad) * Math.cos(q[1] * rad);
  const x =
    Math.cos(p[1] * rad) * Math.sin(q[1] * rad) - Math.sin(p[1] * rad) * Math.cos(q[1] * rad) * Math.cos((q[0] - p[0]) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** 점 배열의 처음(또는 끝)에서 L m 떨어진 점 */
function pointAlong(pts: LonLat[], L: number, fromEnd: boolean): LonLat {
  const ps = fromEnd ? [...pts].reverse() : pts;
  let acc = 0;
  for (let i = 1; i < ps.length; i++) {
    acc += distanceM(ps[i - 1]!, ps[i]!);
    if (acc >= L) return ps[i]!;
  }
  return ps[ps.length - 1]!;
}

/** 들어오는 구간 끝 → 나가는 구간 시작 사이의 회전각. -180~180, 오른쪽 + */
export function turnAngle(incoming: LonLat[], outgoing: LonLat[]): number | null {
  if (incoming.length < 2 || outgoing.length < 2) return null;
  const end = incoming[incoming.length - 1]!;
  const inP = pointAlong(incoming, BEARING_SAMPLE_M, true);
  const start = outgoing[0]!;
  const outP = pointAlong(outgoing, BEARING_SAMPLE_M, false);
  // 샘플 점이 기준점과 거의 같으면 방위를 믿을 수 없다 (경로가 되돌아가는 경우 등)
  if (distanceM(inP, end) < 5 || distanceM(start, outP) < 5) return null;
  const inB = bearing(inP, end);
  const outB = bearing(start, outP);
  return ((outB - inB + 540) % 360) - 180;
}

export function classifyTurn(angle: number | null): Turn {
  if (angle === null) return "straight";
  const a = Math.abs(angle);
  if (a < 25) return "straight";
  if (a < 60) return angle > 0 ? "slight-right" : "slight-left";
  if (a < 150) return angle > 0 ? "right" : "left";
  return "uturn";
}

export const TURN_LABEL: Record<Turn, { arrow: string; word: string }> = {
  start: { arrow: "●", word: "출발" },
  straight: { arrow: "↑", word: "직진" },
  "slight-left": { arrow: "↖", word: "왼쪽 방향" },
  "slight-right": { arrow: "↗", word: "오른쪽 방향" },
  left: { arrow: "←", word: "좌회전" },
  right: { arrow: "→", word: "우회전" },
  uturn: { arrow: "↩", word: "유턴" },
};

const CROSSING = /횡단보도/;
const FILLER = /횡단보도|교량|진입|지하도|육교|계단/;

function isMinor(s: Step): boolean {
  if (s.distance < MIN_STEP_M) return true;
  // "도선사거리까지 627m 이동" 처럼 자체 이동 거리가 있으면 본 단계
  return FILLER.test(s.guidance) && !/\d+m 이동/.test(s.guidance);
}

export function countCrossings(text: string): number {
  if (!CROSSING.test(text)) return 0;
  const m = text.match(/(\d+)개의 횡단보도/);
  return m ? Number(m[1]) : 1;
}

/** "A에서 B까지 ...", "A 앞에서 B까지 ..." 의 A */
export function parseAt(g: string): string | null {
  const m = g.match(/^(.+?)(?: 앞)?에서 /);
  return m?.[1]?.trim() || null;
}

/** "...B까지 ..." 의 B */
export function parseTarget(g: string): string | null {
  const m = g.match(/^(?:.+?(?: 앞)?에서 )?(.+?)까지/);
  return m?.[1]?.trim() || null;
}

export function parseRoad(g: string): string | null {
  return g.match(/\(([^)]+)\)\s*$/)?.[1] ?? null;
}

export function buildGuide(steps: Step[]): GuideStep[] {
  // 1) 묶기: minor 는 다음 본 단계 앞에 붙인다. 끝에 남은 minor 는 마지막 묶음 뒤에 붙인다.
  const groups: Step[][] = [];
  let pending: Step[] = [];
  for (const s of steps) {
    pending.push(s);
    if (!isMinor(s)) {
      groups.push(pending);
      pending = [];
    }
  }
  if (pending.length) {
    if (groups.length) groups[groups.length - 1]!.push(...pending);
    else groups.push(pending);
  }

  // 2) 각 묶음을 안내 한 단계로
  const out: GuideStep[] = [];
  groups.forEach((g, i) => {
    const main = g.find((s) => !isMinor(s)) ?? g[g.length - 1]!;
    const points = g.flatMap((s) => s.points);
    const prev = groups[i - 1];
    const angle = prev ? turnAngle(prev.flatMap((s) => s.points), points) : null;
    const turn: Turn = i === 0 ? "start" : classifyTurn(angle);
    const at = g.map((s) => parseAt(s.guidance)).find(Boolean) ?? null;
    const target = parseTarget(main.guidance);
    const road = parseRoad(main.guidance);
    const distance = g.reduce((t, s) => t + s.distance, 0);
    const time = g.reduce((t, s) => t + s.time, 0);
    const crossings = g.reduce((t, s) => t + countCrossings(s.guidance), 0);

    const { arrow, word } = TURN_LABEL[turn];
    const line1 = [`${arrow} ${at && turn !== "straight" ? `${at}에서 ` : ""}${word}`, crossings ? `횡단보도 ${crossings}` : ""]
      .filter(Boolean)
      .join(" · ");
    const line2 = line2For({ target, road }, distance);

    out.push({ turn, angle, at, target, road, distance, time, crossings, line1, line2, raw: g.map((s) => s.guidance), points });
  });
  return out;
}

export function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}
