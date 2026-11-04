// 안경용 WebSocket. 경로: /glass
// 인증: `Authorization: Bearer <GLASS_TOKEN>` 헤더 우선, 헤더를 못 넣는 클라이언트용으로 ?token= 도 받는다.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { GlassInput, Navigator } from "./navigation.js";

function tokenFrom(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function startGlassServer(opts: { port: number; token: string; nav: Navigator; log: (m: string) => void }): Server {
  const { port, token, nav, log } = opts;

  const http = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, clients: wss.clients.size, active: Boolean(nav.current) }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const given = tokenFrom(req);
    if (path !== "/glass" || !given || !safeEqual(given, token)) {
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
    });
    ws.on("close", () => log(`glass disconnected, clients=${wss.clients.size}`));
  });

  nav.onChange((msg) => {
    for (const ws of wss.clients) send(ws, msg);
  });

  // 핫스팟·프록시 경유 시 유휴 연결이 끊기지 않게 30초마다 ping
  const timer = setInterval(() => {
    for (const ws of wss.clients) ws.ping();
  }, 30_000);
  http.on("close", () => clearInterval(timer));

  http.listen(port, () => log(`glass ws listening on :${port}/glass`));
  return http;
}
