// 폰용 HTTP API. 인증: Authorization: Bearer <API_TOKEN> (헤더를 못 넣으면 ?token=)
//
// POST /location  위치 수신. 형식 3가지:
//   - Overland: {"locations":[{"type":"Feature","geometry":{"type":"Point","coordinates":[lon,lat]},
//                 "properties":{"timestamp":"ISO8601","horizontal_accuracy":5}}]}  → 응답 {"result":"ok"} 필수
//     (형식은 aaronpk/Overland-iOS GLManager.m 에서 확인. 실기 미확인)
//   - 단축어 등 단순 형식: {"lat":37.5,"lon":127.0,"acc":10}
//   - OwnTracks: {"_type":"location","lat":..,"lon":..,"acc":..,"tst":epochSec}
// POST /route     {"to":"왕십리역","from":"외대앞역"} 또는 {"to":"왕십리역","lat":..,"lon":..}
//                 from 도 좌표도 없으면 마지막으로 받은 위치를 출발지로 쓴다.
// POST /transit   {"to":"왕십리역","lat":..,"lon":..} → 대중교통 후보 (options[], speech)
// POST /transit/select {"option":1}  (1부터) → 안내 시작
// POST /nav       {"action":"next"|"prev"|"stop"}
// GET  /status
import type { IncomingMessage, ServerResponse } from "node:http";
import { KakaoError, addressAt, searchAddress, searchPlaces, type Place, type PlaceCandidate } from "./kakao.js";
import { DEFAULT_CATEGORY, type Favorites } from "./favorites.js";
import type { Recent } from "./recent.js";
import { messageFor, formatMinutes, type Navigator, type Position } from "./navigation.js";
import { formatDistance } from "./guide.js";
import { planRoute, resolvePlace, type PlaceInput } from "./planner.js";
import type { Chooser } from "./chooser.js";
import { buildTransitGuide, pendingTransit, planTransit, routeCard, speakOption, summarizeOption, type TransitPlan } from "./transit.js";
import { distanceM } from "./guide.js";
import { safeEqual, tokenFrom } from "./auth.js";
import type { Pairing } from "./pairing.js";
import { busUsage } from "./realtime.js";
import { SttError, cleanSpoken, matchSaved, type Transcriber } from "./voice.js";

const MAX_BODY = 5 * 1024 * 1024; // Overland 배치(최대 1000점) 여유
/** 연속 이탈이 이만큼이면 현재 위치에서 재탐색 */
const REROUTE_AFTER = 3;
const REROUTE_COOLDOWN_MS = 30_000;
/** 같은 단축어 요청을 다시 계산하지 않는 시간 */
export const DEDUPE_MS = 30_000;
/** 대중교통을 요청해도 목적지가 이보다 가까우면(직선) 도보로 바로 안내 */
export const WALK_ONLY_M = 800;

export interface ApiDeps {
  nav: Navigator;
  apiToken: string;
  kakaoKey: string;
  log: (m: string) => void;
  /** 경로 시작·재탐색 등을 Slack 으로 알리고 싶을 때 */
  notify?: (text: string) => void;
  /** 안경 앱 페어링 (없으면 /pair/* 끔) */
  pairing?: Pairing;
  /** 목적지 후보가 여럿이면 안경에서 고르게 한다 (없으면 가장 가까운 곳) */
  chooser?: Chooser;
  /** 즐겨찾기 (없으면 /favorites 끔) */
  favorites?: Favorites;
  /** 최근 목적지 (길안내를 시작할 때마다 기록) */
  recents?: Recent;
  /** 음성 → 글자 (없으면 안경 음성 검색 끔) */
  stt?: Transcriber;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid json");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** 받은 본문에서 위치 목록을 뽑는다. 모르는 형식이면 null */
export function parsePositions(body: unknown): Position[] | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  if (Array.isArray(b.locations)) {
    const out: Position[] = [];
    for (const f of b.locations as Record<string, any>[]) {
      const props = f?.properties ?? {};
      // 방문(visit)·트립 요약은 경로 추적에 안 쓴다
      if (props.action === "visit" || props.type === "trip") continue;
      const c = f?.geometry?.coordinates;
      const lon = num(c?.[0]);
      const lat = num(c?.[1]);
      if (lon === undefined || lat === undefined) continue;
      const ts = typeof props.timestamp === "string" ? Date.parse(props.timestamp) : undefined;
      out.push({ lon, lat, acc: num(props.horizontal_accuracy), ts: Number.isFinite(ts) ? ts : undefined });
    }
    return out;
  }

  // OwnTracks 는 위치 외에 status, lwt, transition 등도 보낸다. 위치가 아니면 빈 목록 (200 으로 받아 줘야 재전송 안 함)
  if (typeof b._type === "string" && b._type !== "location") return [];
  const lat = num(b.lat ?? b.latitude);
  const lon = num(b.lon ?? b.lng ?? b.longitude);
  if (lat === undefined || lon === undefined) return null;
  const tst = num(b.tst);
  return [{ lat, lon, acc: num(b.acc ?? b.accuracy), ts: tst !== undefined ? tst * 1000 : Date.now() }];
}

export function createApi(deps: ApiDeps) {
  const { nav, apiToken, kakaoKey, log, notify, pairing, chooser, favorites, recents, stt } = deps;

  const pt = (p: Place) => ({ lon: p.x, lat: p.y, name: p.name });
  let lastLocLog = { key: "", at: 0 };
  /** 음성 검색은 한 번에 하나 (고르는 중에 또 오면 앞 선택지가 기본값으로 끝나 엉뚱한 곳으로 안내가 시작됨) */
  let voiceBusy = false;
  const candLabel = (c: PlaceCandidate) => (c.distance === null ? c.name : `${c.name} · ${formatDistance(c.distance)}`);

  /** 출발지를 정하고 그 근처에서 목적지 후보를 찾는다 */
  async function findDestination(from: PlaceInput, to: string): Promise<{ f: Place; cands: PlaceCandidate[] }> {
    const f = await resolvePlace(from, kakaoKey);
    const cands = await searchPlaces(to, kakaoKey, { lon: f.x, lat: f.y });
    if (!cands.length) throw new KakaoError(`장소를 찾지 못했습니다: ${to}`);
    return { f, cands };
  }

  /** 안경에서 고르기. 고른 번호 (시간이 지나면 0 = 첫 번째), 취소면 null */
  async function pickOnGlasses(title: string, items: string[], plan?: TransitPlan): Promise<number | null> {
    const i = await chooser!.ask(title, items, plan?.options.map(routeCard));
    log(`choose: ${title} → ${i === null ? "default" : i === -1 ? "cancel" : `#${i + 1}`}`);
    return i === -1 ? null : (i ?? 0);
  }

  /** 도보 안내 시작. 단축어가 읽을 문장을 돌려준다 */
  async function startWalk(f: Place, t: Place): Promise<string> {
    const planned = await planRoute(pt(f), pt(t), kakaoKey);
    nav.start({ ...planned, startedBy: "api" });
    recents?.add(t);
    const a = nav.current!;
    log(`api route: ${planned.from.name} -> ${planned.to.name}, ${a.guide.length} steps`);
    notify?.(`:walking: *${planned.from.name} → ${planned.to.name}* · ${formatDistance(planned.route.totalDistance)} · 약 ${formatMinutes(planned.route.totalTime)} · ${a.guide.length}단계 (단축어에서 시작)`);
    return `${planned.to.name}까지 ${formatDistance(planned.route.totalDistance)}, 약 ${formatMinutes(planned.route.totalTime)}.${a.guide[0] ? ` 먼저 ${a.guide[0].line2.split(" · ")[0]}.` : ""}`;
  }

  /**
   * 대중교통 후보. 도보로 대신 가야 하면 그 이유(단축어가 읽을 문장 앞부분)를 돌려준다:
   * 직선 WALK_ONLY_M 안이면 묻지도 않고, 카카오가 경로를 안 주면(NO_RESULTS, 2026-11-04 약 130m 에서 확인) 그것도 도보로
   */
  async function transitOrWalk(f: Place, t: Place): Promise<TransitPlan | string> {
    const d = distanceM([f.x, f.y], [t.x, t.y]);
    if (d < WALK_ONLY_M) {
      log(`transit: ${t.name} 직선 ${Math.round(d)}m → 도보`);
      return "가까워서 도보로 안내합니다.";
    }
    try {
      return await planTransit(pt(f), pt(t), kakaoKey);
    } catch (e) {
      if (!(e instanceof KakaoError)) throw e;
      log(`transit 없음 (${e.message}) → 도보: ${t.name}`);
      return "대중교통 경로가 없어 도보로 안내합니다.";
    }
  }

  async function startTransitOption(plan: TransitPlan, i: number): Promise<string> {
    const option = plan.options[i]!;
    const { guide, route: r } = await buildTransitGuide(plan, option, kakaoKey);
    nav.start({ from: plan.from, to: plan.to, route: r, guide, mode: "transit", startedBy: "api" });
    recents?.add(plan.to);
    notify?.(`:bus: *${summarizeOption(option, i)}* (단축어에서 시작)`);
    return `${i + 1}번 경로로 안내합니다. ${guide[0]?.line1.replace(/^\S+\s/, "") ?? ""}`;
  }

  /** 안경에서 이어서 하는 흐름 (단축어에는 이미 응답함). 결과는 안경 알림으로 */
  function continueOnGlasses(what: string, job: () => Promise<string | null>) {
    selectReply = { at: Date.now(), speech: "안경에서 고르세요." };
    pendingTransit.set(null);
    void job()
      .then((text) => chooser?.notice(text ?? `${what} 취소`))
      .catch((e) => {
        log(`glasses flow failed: ${e instanceof Error ? e.message : String(e)}`);
        chooser?.notice("경로 찾기 실패");
      });
  }

  /** 안경 메뉴용 즐겨찾기 목록 (마지막 위치에서 직선거리 포함) */
  function favoritesForGlasses() {
    const p = nav.lastKnownPosition;
    return {
      type: "favorites" as const,
      categories: favorites?.categories() ?? [],
      items: (favorites?.list() ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        category: f.category,
        address: f.address,
        distance: p ? Math.round(distanceM([p.lon, p.lat], [f.x, f.y])) : null,
      })),
      // 최근 목적지 (안경은 "최근" 카테고리로 맨 앞에). id 는 "r:" + 이름
      recent: (recents?.list() ?? []).map((r) => ({
        id: `r:${r.name}`,
        name: r.name,
        address: r.address,
        distance: p ? Math.round(distanceM([p.lon, p.lat], [r.x, r.y])) : null,
      })),
    };
  }

  /** 안경 메뉴에서 고른 즐겨찾기로 안내 시작 (출발 = 마지막으로 받은 위치). 결과 문장 */
  async function goFavorite(id: string, mode: "walk" | "transit"): Promise<string> {
    const fav = id.startsWith("r:") ? recents?.get(id.slice(2)) : favorites?.get(id);
    if (!fav) return "목적지를 찾지 못함";
    const p = nav.lastKnownPosition;
    if (!p) return "현재 위치 없음 (Overland 확인)";
    const f: Place = { name: "현재 위치", address: "", x: p.lon, y: p.lat };
    const t: Place = { name: fav.name, address: fav.address, x: fav.x, y: fav.y };
    log(`${id.startsWith("r:") ? "recent" : "favorite"}: ${fav.name} (${mode})`);
    return goPlace(f, t, mode);
  }

  /** 현재 위치에서 t 로 안내 시작: 가까우면 도보, 멀면 대중교통 후보를 안경에서 고름. 결과 문장 */
  async function goPlace(f: Place, t: Place, mode: "walk" | "transit"): Promise<string> {
    const fav = t;
    if (mode === "walk") {
      await startWalk(f, t);
      return `${fav.name} 도보 안내 시작`;
    }
    const plan = await transitOrWalk(f, t);
    if (typeof plan === "string") {
      await startWalk(f, t);
      return `${fav.name} 도보 안내 (${plan.startsWith("가까워") ? "가까움" : "대중교통 없음"})`;
    }
    const k = plan.options.length > 1 && chooser?.available ? await pickOnGlasses(`경로 선택 · ${fav.name}`, plan.options.map(summarizeOption), plan) : 0;
    if (k === null) return "경로 선택 취소";
    await startTransitOption(plan, k);
    return `${fav.name} 안내 시작`;
  }

  /**
   * 안경 마이크로 말한 목적지. 글자로 바꾼 뒤 즐겨찾기·최근 목적지에서 닮은 것(★) + 카카오 검색 후보를
   * "들은 말: …" 제목으로 안경에 띄워 고르게 한다 (잘못 알아들었으면 뒤로 = 취소하고 다시 말하기).
   * 후보가 하나여도 확인을 받는다. 고르면 즐겨찾기와 같은 규칙 (가까우면 도보, 멀면 대중교통)
   */
  async function goVoice(audio: Buffer): Promise<string> {
    if (!stt) return "서버에 음성 인식 키가 없음";
    return oneAtATime(async () => {
      let heard: string;
      try {
        heard = await stt!(audio, savedPlaces().map((x) => x.name));
      } catch (e) {
        log(`voice: ${e instanceof Error ? e.message : String(e)}`);
        return e instanceof SttError ? e.message : "음성 인식 실패";
      }
      return voiceFlow([heard]);
    });
  }

  /**
   * 안경이 스스로 알아들은 글자 (안드로이드 음성 인식, 키 없음). texts = 인식 후보 (가장 그럴듯한 것부터).
   * 그다음은 서버 음성 인식과 같은 흐름
   */
  async function goVoiceText(texts: string[]): Promise<string> {
    return oneAtATime(() => voiceFlow(texts));
  }

  async function oneAtATime(job: () => Promise<string>): Promise<string> {
    if (voiceBusy) return "앞의 음성 검색을 처리하는 중 · 끝난 뒤 다시";
    voiceBusy = true;
    try {
      return await job();
    } finally {
      voiceBusy = false;
    }
  }

  const savedPlaces = () => [
    ...(favorites?.list() ?? []).map((x) => ({ name: x.name, address: x.address, x: x.x, y: x.y })),
    ...(recents?.list() ?? []).map((x) => ({ name: x.name, address: x.address, x: x.x, y: x.y })),
  ];

  async function voiceFlow(heardList: string[]): Promise<string> {
    const saved = savedPlaces();
    const alts = [...new Set(heardList.map(cleanSpoken).filter(Boolean))].slice(0, 3);
    const spoken = alts[0] ?? "";
    log(`voice: "${heardList[0] ?? ""}" → "${spoken}"${alts.length > 1 ? ` (다른 후보: ${alts.slice(1).join(", ")})` : ""}`);
    if (!spoken) return "못 알아들었어요 · 다시 말해 주세요";
    const p = nav.lastKnownPosition;
    if (!p) return `들은 말 "${spoken}" · 현재 위치 없음 (Overland 확인)`;
    const f: Place = { name: "현재 위치", address: "", x: p.lon, y: p.lat };
    // 인식 후보 여러 개 중 어느 것이든 즐겨찾기·최근과 닮으면 ★
    const uniq = saved.filter((x, i) => saved.findIndex((y) => y.name === x.name) === i);
    let shown = spoken;
    const mine = alts.flatMap((t) => matchSaved(t, uniq)).filter((x, i, a) => a.findIndex((y) => y.name === x.name) === i).slice(0, 3);
    let found: PlaceCandidate[] = [];
    try {
      found = await searchPlaces(spoken, kakaoKey, { lon: p.lon, lat: p.lat });
      // 첫 후보로 못 찾으면 다음 인식 후보로 (제목도 그 후보로)
      for (const t of alts.slice(1)) {
        if (found.length) break;
        found = await searchPlaces(t, kakaoKey, { lon: p.lon, lat: p.lat });
        if (found.length) shown = t;
      }
    } catch (e) {
      if (!(e instanceof KakaoError)) throw e;
    }
    const near = (x: Place) => Math.round(distanceM([p.lon, p.lat], [x.x, x.y]));
    const options: { place: Place; label: string }[] = [
      ...mine.map((x) => ({ place: x as Place, label: `★ ${x.name} · ${formatDistance(near(x))}` })),
      ...found.filter((c) => !mine.some((m) => m.name === c.name)).map((c) => ({ place: c as Place, label: candLabel(c) })),
    ].slice(0, 6);
    if (!options.length) return `"${spoken}" 을(를) 찾지 못함 · 다시 말해 주세요`;
    if (!chooser?.available) return "안경 화면 연결 없음";
    const i = await pickOnGlasses(`들은 말: "${shown}"`, options.map((o) => o.label));
    if (i === null) return "취소 · 다시 말하려면 메뉴 > 말해서 찾기";
    return goPlace(f, options[i]!.place, "transit");
  }

  /**
   * 단축어 중복 방지: 네트워크가 끊겨 단축어를 다시 실행하면 같은 요청이 또 온다.
   * 같은 경로·목적지·출발 위치(약 10m)로 DEDUPE_MS 안에 오면 다시 계산하지 않고 지난 응답을 그대로 준다
   */
  const recent = new Map<string, { at: number; body: unknown }>();
  function dedupeKey(route: string, b: Record<string, unknown>) {
    const r4 = (v: unknown) => (num(v) === undefined ? "" : num(v)!.toFixed(4));
    return [route, String(b.to ?? "").trim(), String(b.from ?? "").trim(), r4(b.lat), r4(b.lon)].join("|");
  }
  function replay(key: string): unknown | undefined {
    const hit = recent.get(key);
    if (hit && Date.now() - hit.at < DEDUPE_MS) return hit.body;
    recent.delete(key);
    return undefined;
  }
  function remember(key: string, body: unknown) {
    for (const [k, v] of recent) if (Date.now() - v.at >= DEDUPE_MS) recent.delete(k);
    recent.set(key, { at: Date.now(), body });
  }

  /** 단축어 /transit/select 가 대중교통 후보 대신 받을 답 (도보로 대신 시작했거나 안경에서 고르는 중) */
  let selectReply: { at: number; speech: string } | null = null;

  let lastReroute = 0;
  let rerouting = false;

  async function maybeReroute(offRouteCount: number | undefined) {
    const a = nav.current;
    const p = a?.lastPosition;
    if (!a || !p || rerouting) return;
    if (a.mode === "transit") return; // 대중교통은 도보로 재탐색하면 안 된다. 이탈 표시만
    if ((offRouteCount ?? 0) < REROUTE_AFTER || Date.now() - lastReroute < REROUTE_COOLDOWN_MS) return;
    rerouting = true;
    lastReroute = Date.now();
    try {
      const { from, route } = await planRoute({ lon: p.lon, lat: p.lat }, { lon: a.to.x, lat: a.to.y, name: a.to.name }, kakaoKey);
      nav.reroute(from, route);
      log(`rerouted: ${route.totalDistance}m, ${nav.current?.guide.length} steps`);
      notify?.(`:arrows_counterclockwise: 경로를 벗어나 다시 찾았습니다 · ${a.to.name}까지 ${formatDistance(route.totalDistance)}`);
      chooser?.notice(`경로 다시 찾음 · ${formatDistance(route.totalDistance)}`);
    } catch (e) {
      log(`reroute failed: ${e instanceof Error ? e.message : String(e)}`);
      // 기존 경로는 그대로 두고, 이탈이 계속되면 REROUTE_COOLDOWN_MS 뒤 다시 시도한다
      chooser?.notice("재탐색 실패 · 기존 경로 유지");
    } finally {
      rerouting = false;
    }
  }

  /**
   * 안경 메뉴 "경로 다시 찾기": 마지막 위치에서 같은 목적지로. 도보는 도보로,
   * 대중교통은 대중교통 후보 중 가장 빠른 것으로 (안경에서는 후보를 고를 수 없으므로). 결과 문장을 돌려준다
   */
  async function rerouteNow(): Promise<string> {
    const a = nav.current;
    if (!a) return "진행 중인 경로 없음";
    const p = a.lastPosition ?? nav.lastKnownPosition;
    if (!p) return "위치를 아직 못 받음";
    if (rerouting) return "이미 찾는 중";
    rerouting = true;
    lastReroute = Date.now();
    const here = { lon: p.lon, lat: p.lat };
    const to = { lon: a.to.x, lat: a.to.y, name: a.to.name };
    try {
      if (a.mode === "transit") {
        const plan = await planTransit(here, to, kakaoKey);
        const option = plan.options[0];
        if (!option) return "대중교통 경로 없음";
        const { guide, route } = await buildTransitGuide(plan, option, kakaoKey);
        nav.start({ from: plan.from, to: a.to, route, guide, mode: "transit", startedBy: a.startedBy });
        log(`manual reroute (transit): ${summarizeOption(option, 0)}`);
        return `다시 찾음 · ${summarizeOption(option, 0).replace(/^\S+\s/, "")}`;
      }
      const { from, route } = await planRoute(here, to, kakaoKey);
      nav.reroute(from, route);
      log(`manual reroute: ${route.totalDistance}m`);
      return `다시 찾음 · ${formatDistance(route.totalDistance)}`;
    } catch (e) {
      log(`manual reroute failed: ${e instanceof Error ? e.message : String(e)}`);
      return "다시 찾기 실패";
    } finally {
      rerouting = false;
    }
  }

  function summary() {
    const a = nav.current;
    // 버스 API 오늘 호출 수 (공공데이터포털 하루 한도 확인용)
    const busApi = busUsage();
    if (!a) return { active: false, message: messageFor(null), busApi };
    return {
      active: true,
      busApi,
      from: a.from.name,
      to: a.to.name,
      distance: a.route.totalDistance,
      minutes: Math.round(a.route.totalTime / 60),
      index: a.index,
      total: a.guide.length,
      progress: a.progress,
      offRoute: a.offRoute,
      message: messageFor(a),
      steps: a.guide.map((g) => `${g.line1} · ${g.line2}`),
    };
  }

  /** 위치 반영 + 필요하면 재탐색. HTTP(/location)와 안경 WebSocket 이 같이 쓴다 */
  function ingest(positions: Position[]) {
    const r = nav.updatePositions(positions);
    void maybeReroute(r.offRouteCount);
    return r;
  }

  /** 처리했으면 true. /glass, /healthz 등은 false 를 돌려 다른 핸들러로 넘긴다 */
  const handle = async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    // 안경 페어링: 요청·상태 확인은 인증 없음 (안경에 아직 토큰이 없으므로). 승인은 아래에서 API_TOKEN 으로
    if (pairing && route === "POST /pair/request") {
      const r = pairing.request();
      if (!r) send(res, 429, { error: "too many pending pair requests" });
      else {
        log(`pair request: code ${r.code}`);
        send(res, 200, r);
      }
      return true;
    }
    if (pairing && route === "GET /pair/status") {
      send(res, 200, pairing.status(url.searchParams.get("id") ?? ""));
      return true;
    }
    const routes = ["POST /location", "POST /route", "POST /transit", "POST /transit/select", "POST /nav", "GET /status", "POST /pair/approve"];
    if (favorites) routes.push("GET /favorites", "POST /favorites", "POST /favorites/delete");
    if (!routes.includes(route)) return false;

    const given = tokenFrom(req);
    if (!given || !safeEqual(given, apiToken)) {
      send(res, 401, { error: "unauthorized" });
      return true;
    }

    try {
      if (route === "GET /status") {
        send(res, 200, summary());
        return true;
      }

      if (route === "GET /favorites") {
        send(res, 200, { categories: favorites!.categories(), items: favorites!.list() });
        return true;
      }

      const body = await readJson(req);

      if (route === "POST /location") {
        const positions = parsePositions(body);
        if (positions === null) throw new HttpError(400, "unknown location format");
        const r = ingest(positions);
        if (positions.length) {
          // 2초마다 오는 위치를 다 남기면 로그가 이것으로 찬다: 단계·이탈·거절 이유가 바뀔 때와 1분마다만
          const key = r.accepted ? `${r.index}|${r.offRoute ? 1 : 0}` : String(r.reason);
          if (key !== lastLocLog.key || Date.now() - lastLocLog.at > 60_000) {
            lastLocLog = { key, at: Date.now() };
            log(`location x${positions.length} ${r.accepted ? `s=${r.progress?.toFixed(0)} off=${r.offset?.toFixed(0)}m step=${(r.index ?? 0) + 1}${r.offRoute ? " OFF" : ""}` : r.reason}`);
          }
        }
        // OwnTracks 는 응답으로 JSON 배열(보낼 명령 목록)을 기대한다. Overland 는 {"result":"ok"} 가 필요
        if (typeof (body as Record<string, unknown>)._type === "string") send(res, 200, []);
        else send(res, 200, { result: "ok", ...r });
        return true;
      }

      if (route === "POST /route") {
        const b = body as Record<string, unknown>;
        const dk = dedupeKey(route, b);
        const again = replay(dk);
        if (again !== undefined) {
          log(`api ${route}: 같은 요청 ${DEDUPE_MS / 1000}초 안에 다시 옴 → 지난 응답`);
          send(res, 200, again);
          return true;
        }
        const reply = (x: unknown) => {
          remember(dk, x);
          send(res, 200, x);
        };
        const to = typeof b.to === "string" ? b.to.trim() : "";
        if (!to) throw new HttpError(400, "to is required");
        let from: PlaceInput | null = typeof b.from === "string" && b.from.trim() ? b.from.trim() : null;
        if (!from) {
          const lat = num(b.lat);
          const lon = num(b.lon);
          if (lat !== undefined && lon !== undefined) from = { lat, lon };
          else if (nav.lastKnownPosition) from = { lat: nav.lastKnownPosition.lat, lon: nav.lastKnownPosition.lon };
        }
        if (!from) throw new HttpError(400, "from 또는 lat/lon 이 필요합니다 (받은 위치도 없음)");

        const { f, cands } = await findDestination(from, to);
        if (cands.length > 1 && chooser?.available) {
          // 같은 이름 지점이 여럿 → 안경에서 고르게 하고 단축어에는 바로 응답
          log(`choose: ${to} → ${cands.length} candidates`);
          continueOnGlasses("목적지 선택", async () => {
            const i = await pickOnGlasses(`목적지 선택 · ${to}`, cands.map(candLabel));
            if (i === null) return null;
            const t = cands[i]!;
            await startWalk(f, t);
            return `${t.name} 안내 시작`;
          });
          reply({ active: false, choosing: true, to, speech: `안경에서 ${to} ${cands.length}곳 중 고르세요.` });
          return true;
        }
        const speech = await startWalk(f, cands[0]!);
        // 단축어가 바로 읽어 줄 수 있게 speech 문구도 준다
        reply({ ...summary(), speech });
        return true;
      }

      if (route === "POST /transit") {
        const b = body as Record<string, unknown>;
        const dk = dedupeKey(route, b);
        const again = replay(dk);
        if (again !== undefined) {
          log(`api ${route}: 같은 요청 ${DEDUPE_MS / 1000}초 안에 다시 옴 → 지난 응답`);
          send(res, 200, again);
          return true;
        }
        const reply = (x: unknown) => {
          remember(dk, x);
          send(res, 200, x);
        };
        const to = typeof b.to === "string" ? b.to.trim() : "";
        if (!to) throw new HttpError(400, "to is required");
        let from: PlaceInput | null = typeof b.from === "string" && b.from.trim() ? b.from.trim() : null;
        if (!from) {
          const lat = num(b.lat);
          const lon = num(b.lon);
          if (lat !== undefined && lon !== undefined) from = { lat, lon };
          else if (nav.lastKnownPosition) from = { lat: nav.lastKnownPosition.lat, lon: nav.lastKnownPosition.lon };
        }
        if (!from) throw new HttpError(400, "from 또는 lat/lon 이 필요합니다");
        const { f, cands } = await findDestination(from, to);
        if (cands.length > 1 && chooser?.available) {
          // 목적지와 대중교통 후보 모두 안경에서 고른다. 예전 단축어("목록에서 선택")가 비지 않게 한 줄을 준다
          log(`choose: ${to} → ${cands.length} candidates (transit)`);
          continueOnGlasses("선택", async () => {
            const i = await pickOnGlasses(`목적지 선택 · ${to}`, cands.map(candLabel));
            if (i === null) return null;
            const t = cands[i]!;
            const plan = await transitOrWalk(f, t);
            if (typeof plan === "string") {
              await startWalk(f, t);
              return `${t.name} 도보 안내 시작`;
            }
            const k = plan.options.length > 1 ? await pickOnGlasses(`경로 선택 · ${t.name}`, plan.options.map(summarizeOption), plan) : 0;
            if (k === null) return null;
            await startTransitOption(plan, k);
            return `${t.name} 안내 시작`;
          });
          reply({ choosing: true, to, options: ["① 안경에서 고르는 중"], speech: `안경에서 ${to} ${cands.length}곳 중 고르세요.` });
          return true;
        }
        const t = cands[0]!;
        const plan = await transitOrWalk(f, t);
        if (typeof plan === "string") {
          await startWalk(f, t);
          pendingTransit.set(null);
          selectReply = { at: Date.now(), speech: "도보로 안내 중입니다." };
          const a = nav.current!;
          const min = formatMinutes(a.route.totalTime);
          reply({
            from: f.name,
            to: t.name,
            walking: true,
            // 단축어 "목록에서 선택"이 비지 않게 한 줄. 고르면 /transit/select 가 "도보로 안내 중"으로 답한다
            options: [`① 도보 ${min} · ${t.name} (안내 중)`],
            speech: `${plan} ${t.name}까지 ${formatDistance(a.route.totalDistance)}, 약 ${min}.`,
          });
          return true;
        }
        // 경로 고르기는 안경에서만 (단축어는 목적지만 보낸다). 후보가 하나면 바로 시작
        if (plan.options.length === 1) {
          const speech = await startTransitOption(plan, 0);
          selectReply = { at: Date.now(), speech: "안내 중입니다." };
          pendingTransit.set(null);
          reply({ ...summary(), options: ["① 안내 중"], speech });
          return true;
        }
        if (chooser?.available) {
          log(`choose: ${t.name} → ${plan.options.length} 경로 (안경)`);
          continueOnGlasses("경로 선택", async () => {
            const k = await pickOnGlasses(`경로 선택 · ${t.name}`, plan.options.map(summarizeOption), plan);
            if (k === null) return null;
            await startTransitOption(plan, k);
            return `${t.name} 안내 시작`;
          });
          // 예전 단축어(목록에서 선택이 남아 있는 것)도 깨지지 않게 한 줄
          reply({ choosing: true, to: t.name, options: ["① 안경에서 고르는 중"], speech: `${t.name}, 안경에서 경로를 고르세요. 가장 빠른 길은 ${speakOption(plan.options[0]!, 0).replace(/^1번, /, "")}.` });
          return true;
        }
        // 안경이 연결돼 있지 않으면 가장 빠른 경로로 바로 시작 (단축어에서 고르지 않는다)
        const speech = await startTransitOption(plan, 0);
        selectReply = { at: Date.now(), speech: "안내 중입니다." };
        pendingTransit.set(null);
        reply({ ...summary(), options: ["① 안내 중"], speech: `안경이 연결돼 있지 않아 가장 빠른 경로로 안내합니다. ${speech.replace(/^1번 경로로 안내합니다\. /, "")}` });
        return true;
      }

      if (route === "POST /transit/select") {
        // 바로 앞의 /transit 이 도보로 대신 시작했거나 안경에서 고르는 중이면 그 안내만
        if (!pendingTransit.get() && selectReply && Date.now() - selectReply.at < 5 * 60_000) {
          send(res, 200, { ...summary(), speech: selectReply.speech });
          return true;
        }
        // 번호(1부터) 또는 단축어 "목록에서 선택"으로 고른 후보 문장 그대로("① 16분 · …")
        const opt = (body as Record<string, unknown>).option;
        let n = num(opt);
        if (n === undefined && typeof opt === "string") {
          const t = opt.trim();
          const circled = "①②③④⑤⑥⑦⑧⑨⑩".indexOf(t[0] ?? "");
          if (circled >= 0) n = circled + 1;
          else {
            const i = pendingTransit.get()?.options.findIndex((o, k) => summarizeOption(o, k) === t) ?? -1;
            if (i >= 0) n = i + 1;
          }
        }
        if (n === undefined) throw new HttpError(400, "option (1부터 번호 또는 후보 문장) is required");
        const plan = pendingTransit.get();
        if (!plan) throw new HttpError(400, "먼저 대중교통 후보를 조회하세요.");
        if (!plan.options[n - 1]) throw new HttpError(400, `후보 번호는 1~${plan.options.length} 입니다.`);
        const speech = await startTransitOption(plan, n - 1);
        send(res, 200, { ...summary(), speech });
        return true;
      }

      if (route === "POST /favorites") {
        // 별명 + (주소 또는 장소 이름 | 현재 위치 lat/lon) + 카테고리
        const b = body as Record<string, unknown>;
        const name = typeof b.name === "string" ? b.name.trim() : "";
        const query = typeof b.address === "string" ? b.address.trim() : "";
        const category = typeof b.category === "string" && b.category.trim() ? b.category.trim() : DEFAULT_CATEGORY;
        if (!name) throw new HttpError(400, "name(별명) is required");
        let found: Place | null = null;
        let address = query;
        if (query) {
          // 주소로 먼저, 안 되면 장소 이름으로 (마지막 위치 근처 우선)
          found = await searchAddress(query, kakaoKey);
          if (!found) {
            const p = nav.lastKnownPosition;
            found = (await searchPlaces(query, kakaoKey, p ? { lon: p.lon, lat: p.lat } : undefined))[0] ?? null;
          }
          if (!found) throw new HttpError(404, `주소·장소를 찾지 못했습니다: ${query}`);
        } else {
          const lat = num(b.lat);
          const lon = num(b.lon);
          if (lat === undefined || lon === undefined) throw new HttpError(400, "address 또는 lat/lon 이 필요합니다");
          address = (await addressAt(lon, lat, kakaoKey)) ?? `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
          found = { name: address, address, x: lon, y: lat };
        }
        const fav = favorites!.upsert({ name, category, address, place: found.name, x: found.x, y: found.y });
        log(`favorite added: ${fav.name} [${fav.category}] ${fav.place}${favorites!.saveError ? ` (디스크 저장 실패: ${favorites!.saveError})` : ""}`);
        const warn = favorites!.saveError ? " 서버 디스크 저장에 실패해 재시작하면 사라질 수 있습니다." : "";
        send(res, 200, { ok: true, favorite: fav, ...(warn ? { saveError: favorites!.saveError } : {}), speech: `${fav.category}에 ${fav.name} 등록. ${fav.place}.${warn}` });
        return true;
      }

      if (route === "POST /favorites/delete") {
        const name = String((body as Record<string, unknown>).name ?? "").trim();
        const gone = name ? favorites!.remove(name) : null;
        if (gone && favorites!.saveError) log(`favorite delete: 디스크 저장 실패 (${favorites!.saveError})`);
        send(res, gone ? 200 : 404, gone ? { ok: true, speech: `${gone.name} 삭제.` } : { error: "없는 즐겨찾기", speech: `${name} 즐겨찾기가 없습니다.` });
        return true;
      }

      if (route === "POST /pair/approve") {
        const code = String((body as Record<string, unknown>).code ?? "").trim();
        const ok = pairing?.approve(code) ?? false;
        log(`pair approve ${code}: ${ok ? "ok" : "no match"}`);
        send(res, ok ? 200 : 404, ok ? { ok: true, speech: "안경을 연결했습니다." } : { error: "코드가 없거나 만료됐습니다", speech: "코드를 찾지 못했습니다." });
        return true;
      }

      if (route === "POST /nav") {
        const action = (body as Record<string, unknown>).action;
        if (action === "next") nav.move(1);
        else if (action === "prev") nav.move(-1);
        else if (action === "stop") nav.stop();
        else throw new HttpError(400, "action must be next|prev|stop");
        send(res, 200, summary());
        return true;
      }
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.message });
      else if (e instanceof KakaoError) {
        log(`api ${route}: ${e.message}`);
        send(res, 502, { error: e.message, speech: e.message });
      }
      else {
        log(`api error: ${e instanceof Error ? e.message : String(e)}`);
        send(res, 500, { error: "internal error" });
      }
      return true;
    }
    return false;
  };
  return Object.assign(handle, { ingest, rerouteNow, favoritesForGlasses, goFavorite, goVoice, goVoiceText });
}
