// 안경용 WebSocket. 경로: /glass
// 인증: `Authorization: Bearer <GLASS_TOKEN>` 헤더 우선, 헤더를 못 넣는 클라이언트용으로 ?token= 도 받는다.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { GlassInput, Navigator, Position } from "./navigation.js";
import { safeEqual, tokenFrom } from "./auth.js";
import { VIEWER_HTML } from "./viewer.js";
import type { RoadFeed } from "./roads.js";
import type { Ota } from "./ota.js";

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
}): Server {
  const { port, token, nav, log, api } = opts;
  const onPositions = opts.onPositions ?? ((p: Position[]) => nav.updatePositions(p));

  const http = createServer(async (req, res) => {
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
    if (opts.ota && (await opts.ota.handle(req, res))) return;
    if (api && (await api(req, res))) return;
    res.writeHead(404).end();
  });

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
    const wantsMap = new URL(req.url ?? "/", "http://localhost").searchParams.get("map") === "1";
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
      if (msg.type === "next") nav.move(1);
      else if (msg.type === "prev") nav.move(-1);
      else if (msg.type === "sync") send(ws, nav.snapshot());
      else if (msg.type === "stop") {
        log("glass: stop");
        nav.stop();
      } else if (msg.type === "reroute") {
        if (!opts.onReroute) send(ws, { type: "notice", text: "서버에서 다시 찾기를 지원하지 않음" });
        else void opts.onReroute().then((text) => send(ws, { type: "notice", text }));
      }
      else if (msg.type === "position" && Number.isFinite(msg.lat) && Number.isFinite(msg.lon)) {
        onPositions([{ lat: msg.lat, lon: msg.lon, acc: msg.acc, ts: msg.ts ?? Date.now() }]);
      }
    });
    ws.on("close", () => {
      mapClients.delete(ws);
      log(`glass disconnected, clients=${wss.clients.size}`);
    });
  });

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

  // 핫스팟·프록시 경유 시 유휴 연결이 끊기지 않게 30초마다 ping
  const timer = setInterval(() => {
    for (const ws of wss.clients) ws.ping();
  }, 30_000);
  http.on("close", () => clearInterval(timer));

  http.listen(port, () => log(`glass ws listening on :${port}/glass`));
  return http;
}
