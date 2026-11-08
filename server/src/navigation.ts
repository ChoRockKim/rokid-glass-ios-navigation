// 진행 상태. 개인용이라 활성 경로는 하나만 둔다.
// 진행은 두 가지로 바뀐다: 수동(안경 탭, /route next) 과 위치(POST /location).
import type { LonLat, Place, WalkRoute } from "./kakao.js";
import { buildGuide, distanceM, formatDistance, line2For, type Arrival, type GuideStep, type RideInfo, type StopMark, type Turn } from "./guide.js";
import { RouteTracker } from "./tracking.js";

export { formatDistance };

/** 다음 회전 지점까지 이만큼 남으면 다음 단계를 보여 준다 */
export const ADVANCE_M = 12;
/**
 * 버스·지하철 구간은 하차 지점 이만큼 앞에서 다음 단계로 (정류장은 길가라 위치가 경로선 끝에 딱 닿지 않는다.
 * 2026-11-06: 120 → 241 같은 정류장 환승에서 내린 뒤에도 120 하차 알림이 남음)
 */
export const RIDE_ADVANCE_M = 40;
/**
 * 실제 위치로 본 단계가 앞으로 넘어간 뒤에는, 경계에서 이만큼 더 뒤로 가야 이전 단계로 돌아간다
 * (정류장에 서 있으면 위치가 1~2m 흔들려 하차 알림 ↔ 다음 버스 탑승이 왔다 갔다 했다)
 */
export const BACK_HYSTERESIS_M = 30;
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
  progress: number | null; // 위치 추적 중이면 경로 위 진행 거리(m). 수동 다음/이전으로는 바뀌지 않는다
  realIndex: number | null; // 실제 위치로 본 단계 (index 와 다르면 수동으로 미리 보는 중)
  offRoute: boolean;
  offRouteCount: number; // 연속 이탈 횟수
  lastPosition: Position | null;
  /** 수동으로 고른 단계를 잠시 유지. forward = 실제 단계보다 앞(도착하면 풀림), 아니면 뒤 단계 미리보기 */
  manualHold: { index: number; until: number; forward: boolean } | null;
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
      /** 목적지까지 남은 예상 시간(초). 안경은 받은 시각 + etaSec 로 도착 시각을 표시 (서버·안경 시계 차이 무관) */
      etaSec: number;
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
        /** 실시간을 못 받았을 때 이유 */
        error?: string;
        /** 하차 알림: soon = 다음 정류장(역)에서, now = 이번에 내림. 안경은 테두리를 깜빡인다 */
        alightAlert?: "soon" | "now";
        /** 탄 뒤: 다음에 설 정류장(역) 이름 (정류장 위치를 찾았을 때만). 안경은 지도에서 그 점 옆에 이름을 쓴다 */
        nextStop?: string;
      };
      /** 탈 정류장·역 근처(AT_STOP_M)에서 아직 안 탔으면 그곳의 실시간 도착. 안경 간소 화면이 오른쪽에 보여 준다 */
      stop?: StopBoard;
    }
  | { type: "arrived"; destination: string; text: string }
  | { type: "idle"; text: string };

/** 미니맵용 메시지 (안경 화면 배경). 경로는 시작할 때 한 번, 위치는 바뀔 때마다 */
export type MapMessage =
  | {
      type: "map-route";
      segments: { kind: "walk" | "bus" | "subway"; points: [number, number][] }[];
      turns: [number, number][]; // 각 단계 시작점 (단계 index 와 같은 순서)
      steps?: { line1: string; line2: string }[];
      /** 버스·지하철 구간의 정류장·역 (위치를 찾은 것만). step = 단계 번호 */
      stops?: { step: number; name: string; lon: number; lat: number }[];
    }
  | {
      type: "map-pos";
      lon: number;
      lat: number;
      heading: number;
      snapped: boolean;
      next: number | null;
      /** 실제 위치(폰·안경 GPS)에서 나온 것이면, 그 위치를 받은 지 몇 ms 지났는지 */
      fixAge?: number;
      /** 실제 위치가 아니라 경로 위 추정 지점 (시작점·위치 없이 단계를 넘긴 경우). 화면은 "나"를 그리지 않는다 */
      estimated?: boolean;
      /** 수동으로 다른 단계를 미리 보는 중이면 그 단계 시작점 [lon, lat]. 화면은 지도만 거기로 옮기고 "나"는 실제 위치에 */
      focus?: [number, number] | null;
    }
  | {
      type: "map-roads";
      lines: [number, number][][];
      /** 예전 클라이언트(안경 APK 0.2.4 이하)용. kinds 의 "major" 와 같음 */
      major: boolean[];
      /** 도로 종류: major(간선) · road(일반·골목) · service(진입로) · path(보행로·계단) · rail(철도) */
      kinds: RoadKind[];
      /** 건물 바깥 윤곽 (닫힌 다각형) */
      buildings: [number, number][][];
    };

export type RoadKind = "major" | "road" | "service" | "path" | "rail";

/** 안경에서 받는 메시지 */
export type GlassInput =
  | { type: "next" }
  | { type: "prev" }
  | { type: "sync" }
  /** 안경 메뉴: 안내 종료 */
  | { type: "stop" }
  /** 안경 메뉴: 지금 위치에서 경로 다시 찾기 */
  | { type: "reroute" }
  /** 안경 앱 오류 기록 (앱이 죽었거나 메시지 처리 실패, 다음 연결 때 보냄) */
  | { type: "crash"; text: string; version?: string }
  /** 안경 메뉴: 지금 위치 주변 버스·지하철 도착 */
  /** 안경 마이크로 말한 목적지 (WAV, base64) */
  | { type: "voice"; audio: string }
  /** 안경이 스스로 알아들은 목적지 (안드로이드 음성 인식 후보들, 가장 그럴듯한 것부터) */
  | { type: "voice-text"; texts: string[] }
  | { type: "nearby" }
  /** 안경 메뉴: 즐겨찾기 목록 요청 */
  | { type: "favorites" }
  /** 안경 메뉴: 즐겨찾기로 안내 시작 */
  | { type: "go"; id: string; mode: "walk" | "transit" | "auto" }
  /** 선택지(choose)에 대한 답. index -1 = 취소 */
  | { type: "chosen"; id: number; index: number }
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
  // 다른 단계를 미리 보는 중이면 그 단계 전체 거리로 보여 준다
  if (a.progress === null || a.index >= a.guide.length || a.realIndex !== a.index) return null;
  return Math.max(0, a.tracker.stepEnd[a.index]! - a.progress);
}

/** 정류장 보드: 내가 탈 노선(노선별 도착 두 개까지)과 나머지(노선별 첫 도착) */
export interface StopBoard {
  kind: "bus" | "subway";
  name: string;
  /** times = 받은 시점 문구, etas = 초 (모르면 null). 안경은 연결이 끊겨도 etas 로 남은 시간을 줄여 보여 준다 */
  mine: { line: string; times: string[]; etas: (number | null)[] }[];
  others: { line: string; times: string[]; etas: (number | null)[] }[];
  /** 실시간 조회 실패 이유 (예: "실시간 정보 없음 (서버 응답 없음)") */
  error?: string;
}

/** 탈 정류장에서 이만큼 안이면 정류장 보드를 보낸다 */
export const AT_STOP_M = 100;

/** "3분", "곧 도착", "2역 전" */
export function whenText(a: Arrival): string {
  if (a.etaSec === null) return a.message.replace(/\[.*?\]/g, "").trim() || a.message;
  if (a.etaSec <= 60) return "곧 도착";
  return `${Math.ceil(a.etaSec / 60)}분`;
}

function boardOf(ride: RideInfo, now: number): StopBoard | null {
  const fresh = ride.live && ride.liveAt !== null && now - ride.liveAt < LIVE_MAX_AGE_MS;
  const err = ride.liveError && now - ride.liveError.at < LIVE_MAX_AGE_MS * 3 ? ride.liveError.text : undefined;
  if (!fresh) return err ? { kind: ride.kind, name: ride.board, mine: [], others: [], error: err } : null;
  const sorted = [...ride.live!].sort((x, y) => (x.etaSec ?? 1e9) - (y.etaSec ?? 1e9));
  const group = (xs: Arrival[], per: number) => {
    const out = new Map<string, { times: string[]; etas: (number | null)[] }>();
    for (const a of xs) {
      // 지하철은 같은 호선이라도 방향이 다르면 따로 ("1호선 청량리행")
      const key = ride.kind === "subway" && a.direction ? `${a.line} ${a.direction.split(" - ")[0]}` : a.line;
      const t = out.get(key) ?? { times: [], etas: [] };
      if (t.times.length < per) {
        t.times.push(whenText(a));
        t.etas.push(a.etaSec);
      }
      out.set(key, t);
    }
    return [...out].map(([line, t]) => ({ line, times: t.times, etas: t.etas }));
  };
  return {
    kind: ride.kind,
    name: ride.board,
    mine: group(sorted.filter((a) => a.mine !== false), 2).slice(0, 3),
    others: group(sorted.filter((a) => a.mine === false), 1).slice(0, 8),
  };
}

/** 하차 지점까지 이 안이면 "다음 정류장에서 하차" (정류장 좌표가 없어 정거장 수 추정과 함께 쓴다) */
export const ALIGHT_SOON_M = 600;
/** 이 안이면 "이번 정류장에서 하차" */
export const ALIGHT_NOW_M = 150;

/** 찾은 정류장이 버스 경로선에서 이보다 멀면 다른 곳으로 본다 */
const STOP_MAX_OFFSET_M = 150;
/** 지도 위치를 보낼 최소 이동 거리 · 탄 중 최소 간격 · 가만히 있어도 보내는 간격 */
const POS_MIN_MOVE_M = 3;
const POS_RIDE_MIN_MS = 5_000;
const POS_KEEPALIVE_MS = 15_000;
/** 정류장 지점을 이만큼 지나면 지난 것으로 본다 */
const PASSED_M = 20;

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

/**
 * 남은 정거장 수와 다음 정류장. 위치를 못 찾은 정류장도 센다:
 * 바로 앞뒤로 찾은 정류장 사이(p → k)의 못 찾은 정류장은 거리 비율로 지난 수를 어림한다.
 * 다음 정류장 이름은 바로 다음이 찾은 정류장일 때만 (2026-11-06: 탑승·하차만 찾았을 때 타자마자 "다음 정류장 하차"가 뜬 버그)
 */
export function stopsAhead(r: RideInfo, marks: StopMark[], progress: number): { left: number; next?: string } {
  const n = r.stops.length;
  const idx = (m: StopMark, from: number) => {
    const k = r.stops.indexOf(m.name, from);
    return k < 0 ? r.stops.indexOf(m.name) : k;
  };
  const withK: { m: StopMark; k: number }[] = [];
  for (const m of marks) withK.push({ m, k: idx(m, withK.length ? withK[withK.length - 1]!.k + 1 : 0) });
  const nextI = withK.findIndex((x) => x.m.s > progress + PASSED_M);
  if (nextI < 0) return { left: 1 };
  const nk = withK[nextI]!;
  const prev = withK[nextI - 1];
  const gap = prev ? nk.k - prev.k : nk.k;
  const span = prev ? nk.m.s - prev.m.s : nk.m.s;
  const toNext = gap <= 1 || span <= 0 ? 1 : Math.max(1, Math.ceil((gap * (nk.m.s - progress)) / span));
  const left = Math.max(1, toNext + (n - 1 - nk.k));
  return { left, ...(toNext === 1 ? { next: nk.m.name } : {}) };
}

function rideView(a: ActiveRoute, step: GuideStep, now: number) {
  const r = step.ride!;
  const start = a.tracker.stepStart[a.index] ?? 0;
  const len = Math.max(1, (a.tracker.stepEnd[a.index] ?? start) - start);
  const into = a.progress === null ? 0 : a.progress - start;
  const boarded = into > BOARDED_M;
  const remaining = remainingOf(a) ?? step.distance;
  const stopsTotal = Math.max(1, r.stops.length - 1);
  // 정류장 위치를 찾았으면 지난 정류장을 세고, 못 찾았으면 거리 비율로 추정한다
  const marks = r.marks && r.marks.length >= 2 && a.realIndex === a.index && a.progress !== null ? r.marks : null;
  const ahead = boarded && marks ? stopsAhead(r, marks, a.progress!) : null;
  const allFound = !!marks && marks.length >= r.stops.length;
  const nextStop = ahead?.next;
  const stopsLeft = boarded ? (ahead ? ahead.left : Math.max(1, Math.ceil((stopsTotal * remaining) / len))) : stopsTotal;
  const icon = r.kind === "bus" ? "[버스]" : "[지하철]";
  const name = r.lines.slice(0, 3).join("/");
  const fresh = r.live && r.liveAt !== null && now - r.liveAt < LIVE_MAX_AGE_MS;
  const arrivals = fresh ? r.live!.filter((a) => a.mine !== false).sort((x, y) => (x.etaSec ?? 1e9) - (y.etaSec ?? 1e9)) : [];
  // 하차 알림 (화면만): 남은 정거장이 1이거나 하차 지점까지 ALIGHT_SOON_M 안 → 다음 정류장 하차, ALIGHT_NOW_M 안 → 이번 정류장 하차
  const stopWord = r.kind === "bus" ? "정류장" : "역";
  // 정류장 위치를 알면 남은 정거장 수로만 (도심에선 600m 가 두 정거장일 수 있음)
  const alight: "soon" | "now" | null = !boarded ? null : remaining <= ALIGHT_NOW_M ? "now" : stopsLeft <= 1 || (!ahead && remaining <= ALIGHT_SOON_M) ? "soon" : null;
  const line1 = alight === "now"
    ? `${icon} 이번 ${stopWord}에서 하차`
    : alight === "soon"
      ? `${icon} 다음 ${stopWord}에서 하차`
      : boarded
    ? `${icon} ${name} 탑승 중`
    : arrivals.length
      ? `${icon} ${arrivalsText(arrivals.slice(0, 2))}`
      : `${icon} ${name} 탑승 · ${r.board}`;
  const line2 = !boarded
    ? `${r.board} → ${r.alight} · ${stopsTotal}정거장`
    : nextStop && stopsLeft > 1
      ? `다음 ${nextStop} · ${r.alight} 하차 · ${allFound ? "" : "약 "}${stopsLeft}정거장`
      : `${r.alight} 하차 · ${allFound ? "" : "약 "}${stopsLeft}정거장`;
  return {
    line1,
    line2,
    ride: {
      kind: r.kind, lines: r.lines, board: r.board, alight: r.alight, boarded, stopsLeft, arrivals,
      ...(alight ? { alightAlert: alight } : {}),
      ...(nextStop ? { nextStop } : {}),
      ...(!boarded && !arrivals.length && r.liveError ? { error: r.liveError.text } : {}),
    },
  };
}

/** 목적지까지 남은 예상 시간(초). 지금 단계는 남은 거리 비율로, 아직 안 탄 버스·지하철은 실시간 첫 도착까지 기다리는 시간을 더한다 */
export function etaSecFor(a: ActiveRoute, now: number): number {
  let t = 0;
  for (let i = a.index; i < a.guide.length; i++) {
    const step = a.guide[i]!;
    if (i > a.index) {
      t += step.time;
      continue;
    }
    // 남은 비율은 경로선 길이 기준 (카카오 distance 와 좌표 길이가 다를 수 있다)
    const rem = remainingOf(a);
    const len = (a.tracker.stepEnd[i] ?? 0) - (a.tracker.stepStart[i] ?? 0);
    t += rem === null || len <= 0 ? step.time : step.time * Math.min(1, rem / len);
    if (step.ride) {
      const rv = rideView(a, step, now);
      const first = rv.ride.arrivals[0]?.etaSec;
      if (!rv.ride.boarded && first !== null && first !== undefined) t += Math.max(0, first);
    }
  }
  return Math.round(t);
}

/** 지금 단계(아직 안 탄 탑승) 또는 다음 단계(탑승)의 정류장 근처면 그 정류장 보드 */
function stopBoardFor(a: ActiveRoute, now: number): StopBoard | null {
  const p = a.lastPosition;
  if (!p) return null;
  for (const i of [a.index, a.index + 1]) {
    const step = a.guide[i];
    const ride = step?.ride;
    if (!ride?.boardPoint) continue;
    if (i === a.index) {
      const start = a.tracker.stepStart[i] ?? 0;
      if (a.progress !== null && a.progress - start > BOARDED_M) return null; // 이미 탐
    }
    if (distanceM([p.lon, p.lat], ride.boardPoint) > AT_STOP_M) return null;
    return boardOf(ride, now);
  }
  return null;
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
    etaSec: etaSecFor(active, now),
    offRoute: active.offRoute,
    destination: to.name,
    ...(rv ? { ride: rv.ride } : {}),
    ...((): { stop?: StopBoard } => {
      const b = stopBoardFor(active, now);
      return b ? { stop: b } : {};
    })(),
  };
}

/** 서버가 재시작돼도 안내를 이어 가려고 디스크에 남기는 것 (진행 거리·위치는 다음 위치로 다시 잡힌다) */
export interface SavedRoute {
  v: 1;
  savedAt: number;
  from: Place;
  to: Place;
  mode: "walk" | "transit";
  route: WalkRoute;
  guide: GuideStep[];
  index: number;
  startedBy: string;
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
  private saveListeners = new Set<(s: SavedRoute | null) => void>();
  private mapListeners = new Set<(msg: MapMessage) => void>();
  private lastMapPos: MapMessage | null = null;
  /** 마지막으로 실제 위치를 반영한 시각 (서버 시계) */
  private lastFixAt: number | null = null;
  /** 경로를 시작(또는 복원)한 시각. 위치가 한 번도 안 왔으면 이것부터 잰다 */
  private activeSince = 0;

  /** 경로가 있으면 마지막 위치(없으면 시작)부터 지난 ms, 없으면 null */
  idleMs(): number | null {
    if (!this.active) return null;
    return this.now() - Math.max(this.lastFixAt ?? 0, this.activeSince);
  }
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

  /** 경로 시작·단계 변경·종료 때마다 저장할 내용 (종료면 null) */
  onSave(fn: (s: SavedRoute | null) => void) {
    this.saveListeners.add(fn);
    return () => this.saveListeners.delete(fn);
  }

  saved(): SavedRoute | null {
    const a = this.active;
    if (!a) return null;
    return { v: 1, savedAt: this.now(), from: a.from, to: a.to, mode: a.mode, route: a.route, guide: a.guide, index: a.index, startedBy: a.startedBy };
  }

  private save() {
    const s = this.saved();
    for (const fn of this.saveListeners) fn(s);
  }

  /** 저장해 둔 경로를 그 단계부터 다시 시작 */
  restore(s: SavedRoute) {
    this.start({ from: s.from, to: s.to, route: s.route, guide: s.guide, mode: s.mode, startedBy: s.startedBy });
    if (s.index > 0) this.move(Math.min(s.index, s.guide.length));
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
    if (this.lastMapPos?.type === "map-pos") {
      const { fixAge: _, ...pos } = this.lastMapPos;
      out.push(this.lastFixAt === null ? pos : { ...pos, fixAge: this.now() - this.lastFixAt });
    }
    else {
      const p = a.tracker.pointAt(0);
      if (p) out.push({ type: "map-pos", ...p, snapped: true, estimated: true, next: a.index + 1 < a.guide.length ? a.index + 1 : null });
    }
    return out;
  }

  private routeMap(a: ActiveRoute): MapMessage {
    const q = (p: LonLat): [number, number] => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
    return {
      type: "map-route",
      segments: a.guide.map((g) => ({ kind: g.ride ? g.ride.kind : "walk", points: g.points.map(q) })),
      turns: a.guide.map((g) => q(g.points[0] ?? [0, 0])),
      // 연결이 끊겨도 안경이 링으로 단계 문구를 넘겨 볼 수 있게 (단계 시작 시점 문구)
      steps: a.guide.map((g) => ({ line1: g.line1, line2: g.line2 })),
      stops: a.guide.flatMap((g, step) => (g.ride?.marks ?? []).map((m) => ({ step, name: m.name, lon: m.lon, lat: m.lat }))),
    };
  }

  /** 미리 보는 단계의 시작점 (실제 단계와 같으면 null) */
  private focusOf(a: ActiveRoute): [number, number] | null {
    if (a.realIndex === null || a.realIndex === a.index) return null;
    const step = a.guide[a.index] ?? a.guide[a.guide.length - 1];
    const pt = a.index < a.guide.length ? step?.points[0] : step?.points[step.points.length - 1];
    return pt ? [pt[0], pt[1]] : null;
  }

  /** 진행 거리 기준 내 위치·방향을 미니맵에 알린다. 이탈 중이면 실제 위치. 미리보기 중이면 focus 를 함께 */
  private emitPos(a: ActiveRoute, raw: Position | null) {
    const next = a.index + 1 < a.guide.length ? a.index + 1 : null;
    const fix = raw ? { fixAge: 0 } : {};
    const focus = this.focusOf(a);
    let msg: MapMessage | null = null;
    if (!a.offRoute && a.progress !== null) {
      const p = a.tracker.pointAt(a.progress);
      if (p) msg = { type: "map-pos", ...p, snapped: true, next, focus, ...fix };
    }
    const at = raw ?? a.lastPosition;
    if (!msg && at) {
      const heading = (this.lastMapPos?.type === "map-pos" ? this.lastMapPos.heading : 0);
      msg = { type: "map-pos", lon: at.lon, lat: at.lat, heading, snapped: false, next, focus, ...fix };
    }
    if (msg && (!raw || this.posWorthSending(a, msg))) {
      this.lastPosSentAt = this.now();
      this.emitMap(msg);
    }
  }

  /**
   * 안경 배터리: 폰 위치(약 2초마다)가 올 때마다 보내지 않는다. 3m 넘게 움직였거나 방향이 15° 넘게 바뀌었거나
   * 단계·미리보기·경로 위 여부가 바뀌었을 때만. 버스·지하철을 타고 있으면 5초에 한 번까지.
   * 가만히 있어도 POS_KEEPALIVE_MS 마다는 보낸다 (안경은 이걸로 "위치 N초 전"을 판단, 30초 넘으면 표시)
   */
  private posWorthSending(a: ActiveRoute, msg: MapMessage & { type: "map-pos" }): boolean {
    const last = this.lastMapPos;
    if (last?.type !== "map-pos") return true;
    const age = this.now() - this.lastPosSentAt;
    if (age >= POS_KEEPALIVE_MS) return true;
    if (last.next !== msg.next || last.snapped !== msg.snapped || JSON.stringify(last.focus ?? null) !== JSON.stringify(msg.focus ?? null)) return true;
    const step = a.guide[a.index];
    const start = a.tracker.stepStart[a.index] ?? 0;
    const riding = !!step?.ride && a.progress !== null && a.progress - start > BOARDED_M;
    if (riding && age < POS_RIDE_MIN_MS) return false;
    const turn = Math.abs(((msg.heading - last.heading + 540) % 360) - 180);
    return distanceM([last.lon, last.lat], [msg.lon, msg.lat]) >= POS_MIN_MOVE_M || turn >= 15;
  }
  private lastPosSentAt = 0;

  /** force=false 면 직전과 같은 내용(남은 거리는 10m 단위)은 보내지 않는다. 안경 화면 깜빡임 방지 */
  private emit(force = true) {
    const msg = messageFor(this.active, this.now());
    const key = JSON.stringify(
      msg.type === "step"
        ? { ...msg, remaining: msg.remaining === null ? null : Math.round(msg.remaining / 10), etaSec: Math.round(msg.etaSec / 60), line2: undefined, text: undefined }
        : msg,
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
      realIndex: null,
      offRoute: false,
      offRouteCount: 0,
      lastPosition: null,
      manualHold: null,
    };
    this.lastMapPos = null;
    this.lastFixAt = null;
    this.activeSince = this.now();
    this.emitMap(this.routeMap(this.active));
    const p0 = this.active.tracker.pointAt(0);
    if (p0) this.emitMap({ type: "map-pos", ...p0, snapped: true, estimated: true, next: guide.length > 1 ? 1 : null });
    this.emit();
    this.save();
    this.locateStops(this.active);
  }

  /**
   * 버스·지하철 구간 정류장 위치 찾기 (index.ts 가 카카오 검색으로 채운다). 없으면 정류장 점 없이 안내.
   * 찾은 위치는 그 구간 경로선 위로 옮겨 놓는다 (경로선에서 멀면 버림)
   */
  stopLocator: ((ride: RideInfo, points: [number, number][]) => Promise<({ lon: number; lat: number } | null)[]>) | null = null;

  private locateStops(a: ActiveRoute) {
    const find = this.stopLocator;
    if (!find) return;
    a.guide.forEach((g, i) => {
      const r = g.ride;
      // 재시작 뒤 복원한 경로도 다시 (기억해 둔 위치는 호출 없이 바로, 어림 위치는 정확한 위치로 바뀔 수 있음)
      if (!r || r.stops.length < 2) return;
      void find(r, g.points)
        .then((found) => {
          if (this.active !== a) return;
          const lo = a.tracker.stepStart[i] ?? 0;
          const hi = a.tracker.stepEnd[i] ?? lo;
          const marks: StopMark[] = [];
          r.stops.forEach((name, k) => {
            const f = found[k];
            const p = f ? a.tracker.projectIn([f.lon, f.lat], lo, hi) : null;
            if (!p || p.offset > STOP_MAX_OFFSET_M) return;
            if (marks.length && p.s < marks[marks.length - 1]!.s) return; // 순서가 뒤집히면 잘못 찾은 것
            const at = a.tracker.pointAt(p.s)!;
            marks.push({ name, lon: Math.round(at.lon * 1e6) / 1e6, lat: Math.round(at.lat * 1e6) / 1e6, s: Math.round(p.s) });
          });
          r.marks = marks;
          this.emitMap(this.routeMap(a));
          this.emit(false);
          this.save();
        })
        .catch(() => {});
    });
  }

  /** 재탐색: 목적지는 그대로, 경로만 바꾼다 */
  reroute(from: Place, route: WalkRoute) {
    if (!this.active) return;
    const { to, startedBy } = this.active;
    this.start({ from, to, route, startedBy });
  }

  /**
   * 수동 다음/이전 (안경 쓸기·탭, /nav). index는 guide.length 까지 갈 수 있다 (= 도착).
   * 위치 추적 중이면 진행 거리(=내 위치)는 그대로 두고 화면만 그 단계를 미리 보여 준다 (map-pos focus).
   * 앞 단계로 넘긴 것은 실제로 그 단계에 들어서면 풀리고, 뒤 단계 미리보기는 MANUAL_HOLD_MS 뒤에 실제 단계로 돌아온다.
   */
  move(delta: number) {
    const a = this.active;
    if (!a) return;
    a.index = Math.min(a.guide.length, Math.max(0, a.index + delta));
    a.offRoute = false;
    a.offRouteCount = 0;
    if (a.realIndex !== null && a.index !== a.realIndex) {
      a.manualHold = { index: a.index, until: this.now() + MANUAL_HOLD_MS, forward: a.index > a.realIndex };
    } else a.manualHold = null;
    if (a.progress !== null) this.emitPos(a, null);
    else {
      // 실제 위치를 모르면 그 단계 시작점을 추정 위치로 (화면은 "나"를 그리지 않음)
      const p = a.index < a.guide.length ? a.tracker.pointAt(a.tracker.stepStart[a.index] ?? 0) : null;
      if (p) this.emitMap({ type: "map-pos", ...p, snapped: true, estimated: true, next: a.index + 1 < a.guide.length ? a.index + 1 : null });
    }
    this.emit();
    this.save();
  }

  stop() {
    this.active = null;
    this.lastMapPos = null;
    this.emit();
    this.save();
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
    step.ride.liveError = null;
    this.emit(false);
  }

  /** 실시간 조회 실패. 받아 둔 정보는 그대로 두고(90초 지나면 안 씀) 이유만 붙인다 */
  setArrivalsError(step: GuideStep, text: string) {
    if (!step.ride || !this.active?.guide.includes(step)) return;
    step.ride.liveError = { text, at: this.now() };
    this.emit(false);
  }

  /** 위치 여러 개를 시간순으로 반영하고 마지막에 한 번만 안경에 보낸다 */
  updatePositions(positions: Position[]): PositionResult {
    const sorted = [...positions].sort((x, y) => (x.ts ?? 0) - (y.ts ?? 0));
    const before = this.active ? `${this.active.index}` : null;
    let result: PositionResult = { accepted: false, reason: "no-route" };
    for (const p of sorted) result = this.apply(p);
    this.emit(false);
    if (this.active && `${this.active.index}` !== before) this.save();
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
    this.lastFixAt = this.now();

    const proj = a.tracker.project([p.lon, p.lat] as LonLat, a.progress ?? undefined);
    if (!proj) return { accepted: false, reason: "no-route" };

    const limit = Math.max(OFF_ROUTE_M, (p.acc ?? 0) * 1.5);
    a.offRoute = proj.offset > limit;
    a.offRouteCount = a.offRoute ? a.offRouteCount + 1 : 0;

    if (!a.offRoute) {
      a.progress = proj.s;
      const adv = (i: number) => (a.guide[i]?.ride ? RIDE_ADVANCE_M : ADVANCE_M);
      let real = a.tracker.stepAt(proj.s, adv);
      const prev = a.realIndex;
      // 한 번 넘어간 단계는 경계에서 BACK_HYSTERESIS_M 넘게 뒤로 가야 되돌린다
      if (prev !== null && real < prev && prev <= a.guide.length) {
        const boundary = (a.tracker.stepEnd[prev - 1] ?? 0) - adv(prev - 1);
        if (proj.s > boundary - BACK_HYSTERESIS_M) real = prev;
      }
      a.realIndex = real;
      let index = real;
      const hold = a.manualHold;
      if (hold) {
        const reached = hold.forward && real >= hold.index;
        if (this.now() < hold.until && !reached) index = hold.index;
        else a.manualHold = null;
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
