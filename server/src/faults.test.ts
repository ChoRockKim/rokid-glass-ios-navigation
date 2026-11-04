// 네트워크 오류 처리: 가짜 카카오 서버로 재시도·오류 주입·단축어 중복 방지를 확인한다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

let srv: Server;
let mode: "flaky" | "400" | "ok" = "ok";
let hits = 0;
const walk = {
  status: "OK",
  route: {
    properties: { totalDistance: 300, totalTime: 240 },
    legs: [{ steps: [{ path: { points: [[127, 37.5], [127, 37.502]] }, properties: { distance: 300, guidance: "선릉역까지 300m 이동", time: 240, x: 127, y: 37.5 } }] }],
  },
};

before(async () => {
  srv = createServer((req, res) => {
    hits++;
    const u = new URL(req.url!, "http://x");
    res.setHeader("content-type", "application/json");
    if (mode === "400") return res.writeHead(400).end(JSON.stringify({ message: "bad" }));
    if (mode === "flaky" && hits === 1) return res.writeHead(502).end(JSON.stringify({ message: "gateway" }));
    if (u.pathname.endsWith("address.json")) return res.end(JSON.stringify({ documents: [{ address_name: "서울 강남구 테헤란로 1", x: "127.0", y: "37.5" }] }));
    if (u.pathname.endsWith("keyword.json")) return res.end(JSON.stringify({ documents: [{ place_name: "선릉역 2호선", x: "127.0", y: "37.502", distance: "220" }] }));
    if (u.pathname.endsWith("walk")) return res.end(JSON.stringify(walk));
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => srv.listen(0, r));
  process.env.KAKAO_BASE = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
after(() => srv.close());

test("카카오: 5xx 는 한 번 다시 시도해 성공, 400 은 바로 실패, 오류 주입은 바로 실패", async () => {
  const { searchAddress, KakaoError } = await import("./kakao.js");
  mode = "flaky"; hits = 0;
  assert.equal((await searchAddress("테헤란로 1", "k"))?.address, "서울 강남구 테헤란로 1");
  assert.equal(hits, 2);
  mode = "400"; hits = 0;
  await assert.rejects(searchAddress("x", "k"), (e) => e instanceof KakaoError && /400/.test(e.message));
  assert.equal(hits, 1);
  mode = "ok"; hits = 0;
  process.env.FAULTS = "kakao";
  await assert.rejects(searchAddress("x", "k"), (e) => e instanceof KakaoError && /오류 주입/.test(e.message));
  assert.equal(hits, 0);
  delete process.env.FAULTS;
});

test("단축어 중복 방지: 같은 /route 가 30초 안에 다시 오면 다시 계산하지 않음", async () => {
  const { createApi } = await import("./api.js");
  const { Navigator } = await import("./navigation.js");
  const nav = new Navigator();
  const logs: string[] = [];
  const api = createApi({ nav, apiToken: "a", kakaoKey: "k", log: (m) => logs.push(m) });
  const http = createServer((q, r) => void api(q, r));
  await new Promise<void>((r) => http.listen(0, r));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/route?token=a`;
  const body = JSON.stringify({ to: "선릉역", lat: 37.5, lon: 127.0 });
  mode = "ok"; hits = 0;
  const a = await (await fetch(url, { method: "POST", body })).json();
  const first = hits;
  const b = await (await fetch(url, { method: "POST", body })).json();
  http.close();
  assert.deepEqual(b, a);
  assert.equal(hits, first); // 카카오를 다시 부르지 않음
  assert.ok(logs.some((l) => /같은 요청/.test(l)));
});

test("실시간 실패 이유", async () => {
  const { realtimeReason } = await import("./realtime.js");
  assert.equal(realtimeReason(new Error("ws.bus.go.kr 401: Unauthorized")), "실시간 정보 없음 (API 키 확인 필요)");
  assert.equal(realtimeReason(new Error("fetch failed")), "실시간 정보 없음 (서버 응답 없음)");
  assert.equal(realtimeReason(new Error("swopenapi.seoul.go.kr 503: x")), "실시간 정보 없음 (서버 응답 없음)");
});

test("실시간 폴러: 실패하면 안경 메시지에 이유", async () => {
  const { startRealtimePoller } = await import("./realtime.js");
  const { Navigator } = await import("./navigation.js");
  const nav = new Navigator();
  const step = {
    turn: "bus", angle: null, at: null, target: null, road: null, distance: 1000, time: 600, crossings: 0, line1: "[버스] 421", line2: "", raw: [],
    points: [[127, 37.5], [127, 37.51]],
    ride: { kind: "bus", lines: ["421"], board: "A", alight: "B", stops: ["A", "B"], boardPoint: [127, 37.5], live: null, liveAt: null },
  } as never;
  const place = { name: "x", address: "", x: 0, y: 0 };
  nav.start({ from: place, to: place, route: { totalDistance: 1, totalTime: 1, steps: [] }, guide: [step], mode: "transit", startedBy: "t" });
  const stop = startRealtimePoller(nav, [{ name: "fake", supports: () => true, fetch: async () => { throw new Error("fetch failed"); } }], () => {});
  await new Promise((r) => setTimeout(r, 1300));
  stop();
  const m = nav.snapshot();
  assert.ok(m.type === "step" && m.ride?.error === "실시간 정보 없음 (서버 응답 없음)");
});
