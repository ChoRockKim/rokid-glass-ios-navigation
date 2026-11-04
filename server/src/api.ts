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
import { KakaoError, searchPlaces, type Place, type PlaceCandidate } from "./kakao.js";
import { messageFor, formatMinutes, type Navigator, type Position } from "./navigation.js";
import { formatDistance } from "./guide.js";
import { planRoute, resolvePlace, type PlaceInput } from "./planner.js";
import type { Chooser } from "./chooser.js";
import { buildTransitGuide, pendingTransit, planTransit, speakOption, summarizeOption, type TransitPlan } from "./transit.js";
import { distanceM } from "./guide.js";
import { safeEqual, tokenFrom } from "./auth.js";
import type { Pairing } from "./pairing.js";

const MAX_BODY = 5 * 1024 * 1024; // Overland 배치(최대 1000점) 여유
/** 연속 이탈이 이만큼이면 현재 위치에서 재탐색 */
const REROUTE_AFTER = 3;
const REROUTE_COOLDOWN_MS = 30_000;
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
  const { nav, apiToken, kakaoKey, log, notify, pairing, chooser } = deps;

  const pt = (p: Place) => ({ lon: p.x, lat: p.y, name: p.name });
  const candLabel = (c: PlaceCandidate) => (c.distance === null ? c.name : `${c.name} · ${formatDistance(c.distance)}`);

  /** 출발지를 정하고 그 근처에서 목적지 후보를 찾는다 */
  async function findDestination(from: PlaceInput, to: string): Promise<{ f: Place; cands: PlaceCandidate[] }> {
    const f = await resolvePlace(from, kakaoKey);
    const cands = await searchPlaces(to, kakaoKey, { lon: f.x, lat: f.y });
    if (!cands.length) throw new KakaoError(`장소를 찾지 못했습니다: ${to}`);
    return { f, cands };
  }

  /** 안경에서 고르기. 고른 번호 (시간이 지나면 0 = 첫 번째), 취소면 null */
  async function pickOnGlasses(title: string, items: string[]): Promise<number | null> {
    const i = await chooser!.ask(title, items);
    log(`choose: ${title} → ${i === null ? "default" : i === -1 ? "cancel" : `#${i + 1}`}`);
    return i === -1 ? null : (i ?? 0);
  }

  /** 도보 안내 시작. 단축어가 읽을 문장을 돌려준다 */
  async function startWalk(f: Place, t: Place): Promise<string> {
    const planned = await planRoute(pt(f), pt(t), kakaoKey);
    nav.start({ ...planned, startedBy: "api" });
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
    } catch (e) {
      log(`reroute failed: ${e instanceof Error ? e.message : String(e)}`);
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
    if (!a) return { active: false, message: messageFor(null) };
    return {
      active: true,
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
    if (!["POST /location", "POST /route", "POST /transit", "POST /transit/select", "POST /nav", "GET /status", "POST /pair/approve"].includes(route)) return false;

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

      const body = await readJson(req);

      if (route === "POST /location") {
        const positions = parsePositions(body);
        if (positions === null) throw new HttpError(400, "unknown location format");
        const r = ingest(positions);
        if (positions.length) {
          log(`location x${positions.length} ${r.accepted ? `s=${r.progress?.toFixed(0)} off=${r.offset?.toFixed(0)}m step=${(r.index ?? 0) + 1}${r.offRoute ? " OFF" : ""}` : r.reason}`);
        }
        // OwnTracks 는 응답으로 JSON 배열(보낼 명령 목록)을 기대한다. Overland 는 {"result":"ok"} 가 필요
        if (typeof (body as Record<string, unknown>)._type === "string") send(res, 200, []);
        else send(res, 200, { result: "ok", ...r });
        return true;
      }

      if (route === "POST /route") {
        const b = body as Record<string, unknown>;
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
          send(res, 200, { active: false, choosing: true, to, speech: `안경에서 ${to} ${cands.length}곳 중 고르세요.` });
          return true;
        }
        const speech = await startWalk(f, cands[0]!);
        // 단축어가 바로 읽어 줄 수 있게 speech 문구도 준다
        send(res, 200, { ...summary(), speech });
        return true;
      }

      if (route === "POST /transit") {
        const b = body as Record<string, unknown>;
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
          // 목적지와 대중교통 후보 모두 안경에서 고른다. 단축어 "목록에서 선택"이 비지 않게 한 줄을 준다
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
            const k = plan.options.length > 1 ? await pickOnGlasses(`경로 선택 · ${t.name}`, plan.options.map(summarizeOption)) : 0;
            if (k === null) return null;
            await startTransitOption(plan, k);
            return `${t.name} 안내 시작`;
          });
          send(res, 200, { choosing: true, to, options: ["① 안경에서 고르는 중"], speech: `안경에서 ${to} ${cands.length}곳 중 고르세요.` });
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
          send(res, 200, {
            from: f.name,
            to: t.name,
            walking: true,
            // 단축어 "목록에서 선택"이 비지 않게 한 줄. 고르면 /transit/select 가 "도보로 안내 중"으로 답한다
            options: [`① 도보 ${min} · ${t.name} (안내 중)`],
            speech: `${plan} ${t.name}까지 ${formatDistance(a.route.totalDistance)}, 약 ${min}.`,
          });
          return true;
        }
        selectReply = null;
        pendingTransit.set(plan);
        send(res, 200, {
          from: plan.from.name,
          to: plan.to.name,
          options: plan.options.map(summarizeOption),
          speech: plan.options.map(speakOption).join(". "),
        });
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
  return Object.assign(handle, { ingest, rerouteNow });
}
