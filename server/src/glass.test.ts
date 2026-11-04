// 안경 WebSocket 서버 안정성: 죽은 연결 정리, 잘못된 메시지·처리 오류에도 서버 유지, 안경 오류 기록
process.env.GLASS_HEARTBEAT_MS = "100";
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { Socket } from "node:net";

test("응답 없는 안경 연결은 끊고, 목적지 고르기 대상에서도 빠진다", async () => {
  const { startGlassServer } = await import("./glass.js");
  const { Navigator } = await import("./navigation.js");
  const { Chooser } = await import("./chooser.js");
  const logs: string[] = [];
  const chooser = new Chooser();
  const srv = startGlassServer({ port: 0, token: "t", nav: new Navigator(), log: (m) => logs.push(m), chooser });
  await new Promise<void>((r) => (srv.listening ? r() : srv.once("listening", () => r())));
  const port = (srv.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/glass?map=1&choose=1&token=t`);
  await new Promise((r) => ws.once("open", r));
  assert.equal(chooser.available, true);
  // 안경이 갑자기 사라진 것처럼: 소켓을 멈춰 ping 에 답하지 않게
  ((ws as unknown as { _socket: Socket })._socket).pause();
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(chooser.available, false);
  assert.ok(logs.some((l) => /응답 없는 연결 끊음/.test(l)));
  ws.terminate();
  srv.close();
});

test("잘못된 메시지·처리 오류에도 서버는 계속, 안경 오류 기록은 로그로", async () => {
  const { startGlassServer } = await import("./glass.js");
  const { Navigator } = await import("./navigation.js");
  const logs: string[] = [];
  const srv = startGlassServer({
    port: 0, token: "t", nav: new Navigator(), log: (m) => logs.push(m),
    favorites: { list: () => { throw new Error("boom"); }, go: async () => "" },
  });
  await new Promise<void>((r) => (srv.listening ? r() : srv.once("listening", () => r())));
  const port = (srv.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/glass?token=t`);
  const got: unknown[] = [];
  ws.on("message", (d) => got.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  ws.send("{not json");
  ws.send(JSON.stringify({ type: "favorites" })); // 처리 중 오류
  ws.send(JSON.stringify({ type: "crash", version: "0.3.19", text: "java.lang.IllegalStateException: x" }));
  ws.send(JSON.stringify({ type: "sync" })); // 그래도 다음 메시지는 처리
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(logs.some((l) => /favorites 처리 실패: Error: boom/.test(l)));
  assert.ok(logs.some((l) => /glass crash report \(v0\.3\.19\): java\.lang\.IllegalStateException/.test(l)));
  assert.equal(got.length, 2); // 연결 때 snapshot + sync 응답
  ws.close();
  srv.close();
});
