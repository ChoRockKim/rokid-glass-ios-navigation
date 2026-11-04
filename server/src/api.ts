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
import { KakaoError } from "./kakao.js";
import { messageFor, formatMinutes, type Navigator, type Position } from "./navigation.js";
import { formatDistance } from "./guide.js";
import { planRoute, type PlaceInput } from "./planner.js";
import { pendingTransit, planTransit, selectTransit, speakOption, summarizeOption } from "./transit.js";
import { safeEqual, tokenFrom } from "./auth.js";
import type { Pairing } from "./pairing.js";

const MAX_BODY = 5 * 1024 * 1024; // Overland 배치(최대 1000점) 여유
/** 연속 이탈이 이만큼이면 현재 위치에서 재탐색 */
const REROUTE_AFTER = 3;
const REROUTE_COOLDOWN_MS = 30_000;

export interface ApiDeps {
  nav: Navigator;
  apiToken: string;
  kakaoKey: string;
  log: (m: string) => void;
  /** 경로 시작·재탐색 등을 Slack 으로 알리고 싶을 때 */
  notify?: (text: string) => void;
  /** 안경 앱 페어링 (없으면 /pair/* 끔) */
  pairing?: Pairing;
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
  const { nav, apiToken, kakaoKey, log, notify, pairing } = deps;
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

        const planned = await planRoute(from, to, kakaoKey);
        nav.start({ ...planned, startedBy: "api" });
        const a = nav.current!;
        log(`api route: ${planned.from.name} -> ${planned.to.name}, ${a.guide.length} steps`);
        notify?.(`:walking: *${planned.from.name} → ${planned.to.name}* · ${formatDistance(planned.route.totalDistance)} · 약 ${formatMinutes(planned.route.totalTime)} · ${a.guide.length}단계 (단축어에서 시작)`);
        // 단축어가 바로 읽어 줄 수 있게 speech 문구도 준다
        send(res, 200, {
          ...summary(),
          speech: `${planned.to.name}까지 ${formatDistance(planned.route.totalDistance)}, 약 ${formatMinutes(planned.route.totalTime)}.${a.guide[0] ? ` 먼저 ${a.guide[0].line2.split(" · ")[0]}.` : ""}`,
        });
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
        const plan = await planTransit(from, to, kakaoKey);
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
        let picked;
        try {
          picked = await selectTransit(n - 1, kakaoKey);
        } catch (e) {
          if (e instanceof KakaoError) throw e;
          throw new HttpError(400, e instanceof Error ? e.message : String(e));
        }
        const { plan, option, guide, route: r } = picked;
        nav.start({ from: plan.from, to: plan.to, route: r, guide, mode: "transit", startedBy: "api" });
        notify?.(`:bus: *${summarizeOption(option, n - 1)}* (단축어에서 시작)`);
        send(res, 200, { ...summary(), speech: `${n}번 경로로 안내합니다. ${guide[0]?.line1.replace(/^\S+\s/, "") ?? ""}` });
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
      else if (e instanceof KakaoError) send(res, 502, { error: e.message });
      else {
        log(`api error: ${e instanceof Error ? e.message : String(e)}`);
        send(res, 500, { error: "internal error" });
      }
      return true;
    }
    return false;
  };
  return Object.assign(handle, { ingest });
}
