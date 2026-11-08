// 안경용 WebSocket. 경로: /glass
// 인증: `Authorization: Bearer <GLASS_TOKEN>` 헤더 우선, 헤더를 못 넣는 클라이언트용으로 ?token= 도 받는다.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { GlassInput, Navigator, Position } from "./navigation.js";
import { safeEqual, tokenFrom } from "./auth.js";
import { VIEWER_HTML } from "./viewer.js";
import { PLACES_HTML } from "./places.js";
import type { RoadFeed } from "./roads.js";
import type { Ota } from "./ota.js";
import type { Chooser } from "./chooser.js";
import { VOICE_MAX_BYTES } from "./voice.js";

/** 이 간격으로 ping, 다음 ping 때까지 pong 이 없으면 끊는다 (최대 2배 시간 안에 정리) */
// 30초 (안경 배터리: 안경 쪽 ping 25초와 함께 Wi-Fi 를 덜 깨운다). 죽은 연결은 최대 60초 안에 정리
export const HEARTBEAT_MS = Number(process.env.GLASS_HEARTBEAT_MS ?? 30_000);

export function startGlassServer(opts: {
  port: number;
  token: string;
  /** 추가로 받아 줄 토큰 (안경 APK 에 넣은 GLASS_DEVICE_TOKEN 등) */
  extraTokens?: string[];
  nav: Navigator;
  log: (m: string) => void;
  /** 폰용 HTTP API. 처리했으면 true */
  api?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /** 안경이 보낸 위치를 반영 (재탐색 포함). 없으면 nav 에 바로 */
  onPositions?: (p: Position[]) => unknown;
  /** 안경 메뉴 "경로 다시 찾기". 결과 문장을 그 안경에만 notice 로 돌려준다 */
  onReroute?: () => Promise<string>;
  /** 미니맵 배경 도로 */
  roads?: RoadFeed;
  /** 안경 앱 OTA (/app/*) */
  ota?: Ota;
  /** 안경 메뉴 즐겨찾기: 목록, 고른 곳으로 안내 시작(결과 문장) */
  favorites?: { list: () => unknown; go: (id: string, mode: "walk" | "transit") => Promise<string> };
  /** 안경 메뉴 "버스·지하철 시간": 지금 위치 주변 정류장·역 실시간 도착 */
  nearby?: () => Promise<unknown>;
  /** 안경 마이크 음성(WAV)으로 목적지 찾기 → 결과 문장 */
  voice?: (audio: Buffer) => Promise<string>;
  /** 안경이 스스로 알아들은 글자(인식 후보들)로 목적지 찾기 → 결과 문장 */
  voiceText?: (texts: string[]) => Promise<string>;
  /** 목적지 후보 선택지. ?choose=1 로 연결한 화면(안경 APK)에만 띄운다 */
  chooser?: Chooser;
}): Server {
  const { port, token, nav, log, api } = opts;
  const onPositions = opts.onPositions ?? ((p: Position[]) => nav.updatePositions(p));

  const http = createServer((req, res) => {
    route(req, res).catch((e) => {
      log(`http ${req.method} ${req.url?.split("?")[0]} 실패: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, clients: wss.clients.size, active: Boolean(nav.current) }));
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && (pathname === "/viewer" || pathname === "/viewer/")) {
      // 안경 화면 미리보기 (토큰은 페이지에서 입력, 브라우저에만 저장)
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(VIEWER_HTML);
      return;
    }
    if (req.method === "GET" && (pathname === "/places" || pathname === "/places/")) {
      // 즐겨찾기 관리 (폰 브라우저). 데이터는 /favorites API (API_TOKEN)
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PLACES_HTML);
      return;
    }
    if (opts.ota && (await opts.ota.handle(req, res))) return;
    if (api && (await api(req, res))) return;
    res.writeHead(404).end();
  }

  const wss = new WebSocketServer({ noServer: true });
  const mapClients = new Set<WebSocket>();

  http.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const given = tokenFrom(req);
    const ok = given !== null && [token, ...(opts.extraTokens ?? [])].some((t) => t && safeEqual(given, t));
    if (path !== "/glass" || !ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const send = (ws: WebSocket, data: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
  };

  wss.on("connection", (ws, req) => {
    log(`glass connected (${req.socket.remoteAddress}), clients=${wss.clients.size}`);
    send(ws, nav.snapshot());
    // 미니맵 메시지는 ?map=1 로 연결한 화면(/viewer)에만. 안경 앱(AIUI)은 모르는 type 을 "경로 없음"으로 처리하기 때문
    const q = new URL(req.url ?? "/", "http://localhost").searchParams;
    const wantsMap = q.get("map") === "1";
    const detach = q.get("choose") === "1" ? opts.chooser?.attach((m) => send(ws, m)) : undefined;
    if (wantsMap) {
      mapClients.add(ws);
      for (const m of nav.mapSnapshot()) send(ws, m);
      const r = opts.roads?.snapshot();
      if (r) send(ws, r);
    }

    ws.on("message", (raw) => {
      let msg: GlassInput;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // 메시지 하나 처리하다 오류가 나도 서버 전체가 죽지 않게
      try {
        handleMessage(ws, msg);
      } catch (e) {
        log(`glass message ${String((msg as { type?: string }).type)} 처리 실패: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      }
    });
    ws.on("close", () => {
      mapClients.delete(ws);
      detach?.();
      log(`glass disconnected, clients=${wss.clients.size}`);
    });
  });

  function handleMessage(ws: WebSocket, msg: GlassInput) {
      if (msg.type === "crash") {
        // 안경 앱이 죽었거나 메시지 처리 중 오류가 난 기록 (다음 연결 때 보낸다). 길이 제한
        log(`glass crash report (v${String(msg.version ?? "?").slice(0, 20)}): ${String(msg.text ?? "").slice(0, 4000)}`);
        return;
      }
      if (msg.type === "next") nav.move(1);
      else if (msg.type === "prev") nav.move(-1);
      else if (msg.type === "sync") send(ws, nav.snapshot());
      else if (msg.type === "nearby") {
        if (!opts.nearby) send(ws, { type: "nearby", boards: [], note: "서버에서 지원하지 않음" });
        else void opts.nearby().then((m) => send(ws, m)).catch((e) => send(ws, { type: "nearby", boards: [], note: `실패: ${e instanceof Error ? e.message : String(e)}` }));
      } else if (msg.type === "favorites") send(ws, opts.favorites?.list() ?? { type: "favorites", categories: [], items: [] });
      else if (msg.type === "go" && opts.favorites) {
        // "auto"(0.3.12+): 대중교통 흐름으로 보내면 가까우면(직선 800m) 도보, 아니면 대중교통 후보 → 안경에서 고름
        const mode = msg.mode === "walk" ? "walk" : "transit";
        void opts.favorites
          .go(String(msg.id), mode)
          .catch((e) => {
            log(`favorite go failed: ${e instanceof Error ? e.message : String(e)}`);
            return "경로 찾기 실패";
          })
          .then((text) => send(ws, { type: "notice", text }));
      } else if (msg.type === "voice") {
        const b64 = typeof msg.audio === "string" ? msg.audio : "";
        const audio = Buffer.from(b64, "base64");
        if (!opts.voice) send(ws, { type: "notice", text: "서버에서 음성 검색을 지원하지 않음" });
        else if (audio.length < 1000 || audio.length > VOICE_MAX_BYTES) send(ws, { type: "notice", text: "음성이 너무 짧거나 김" });
        else
          void opts.voice(audio)
            .catch((e) => {
              log(`voice failed: ${e instanceof Error ? e.message : String(e)}`);
              return "음성 검색 실패";
            })
            .then((text) => send(ws, { type: "notice", text }));
      } else if (msg.type === "voice-text") {
        const texts = (Array.isArray(msg.texts) ? msg.texts : []).filter((t): t is string => typeof t === "string").map((t) => t.slice(0, 100)).slice(0, 5);
        if (!opts.voiceText) send(ws, { type: "notice", text: "서버에서 음성 검색을 지원하지 않음" });
        else
          void opts.voiceText(texts)
            .catch((e) => {
              log(`voice-text failed: ${e instanceof Error ? e.message : String(e)}`);
              return "음성 검색 실패";
            })
            .then((text) => send(ws, { type: "notice", text }));
      } else if (msg.type === "chosen") opts.chooser?.answer(Number(msg.id), Number(msg.index));
      else if (msg.type === "stop") {
        log("glass: stop");
        nav.stop();
      } else if (msg.type === "reroute") {
        if (!opts.onReroute) send(ws, { type: "notice", text: "서버에서 다시 찾기를 지원하지 않음" });
        else void opts.onReroute().then((text) => send(ws, { type: "notice", text })).catch((e) => log(`reroute failed: ${e instanceof Error ? e.message : String(e)}`));
      }
      else if (msg.type === "position" && Number.isFinite(msg.lat) && Number.isFinite(msg.lon)) {
        onPositions([{ lat: msg.lat, lon: msg.lon, acc: msg.acc, ts: msg.ts ?? Date.now() }]);
      }
  }

  nav.onChange((msg) => {
    for (const ws of wss.clients) send(ws, msg);
  });
  // 미니맵: 경로·위치·주변 도로 → map=1 클라이언트에만
  nav.onMap((msg) => {
    for (const ws of mapClients) send(ws, msg);
  });
  opts.roads?.onRoads((msg) => {
    for (const ws of mapClients) send(ws, msg);
  });

  // 15초마다 ping. 직전 ping 에 pong 이 없던 연결은 끊는다 (죽은 안경을 살아 있는 것으로 보면 목적지 고르기를 60초 기다리게 됨)
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on("connection", (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        log("glass: 응답 없는 연결 끊음");
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  http.on("close", () => clearInterval(timer));

  http.listen(port, () => log(`glass ws listening on :${port}/glass`));
  return http;
}
