// 버스 API 하루 한도: 넘으면 자정(한국 시간)까지 부르지 않고, 정류장에서 멀면 덜 자주 부른다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

let srv: Server;
let hits = 0;
let quota = false;
before(async () => {
  srv = createServer((req, res) => {
    hits++;
    if (quota) return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Unauthorized", message: "유효하지 않은 서비스키입니다: 서비스 요청제한 횟수 초과 에러", status: 401 }));
    const u = new URL(req.url!, "http://x");
    res.setHeader("content-type", "application/json");
    if (u.pathname.endsWith("getStationByPos")) return res.end(JSON.stringify({ msgBody: { itemList: [{ arsId: "06123", stationNm: "외대앞", dist: "40" }] } }));
    res.end(JSON.stringify({ msgBody: { itemList: [{ rtNm: "120", arrmsg1: "3분후[1번째 전]", arrmsg2: "9분후[5번째 전]" }] } }));
  });
  await new Promise<void>((r) => srv.listen(0, r));
});
after(() => srv.close());

test("한도 초과 오류면 자정(KST)까지 다시 부르지 않고, 안경에는 이유", async () => {
  const { seoulBusProvider, resetBusQuota, busUsage, realtimeReason, QuotaError, nextKstMidnight } = await import("./realtime.js");
  const { busBoard } = await import("./nearby.js");
  resetBusQuota();
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const p = seoulBusProvider("k", base);
  const ride = { kind: "bus" as const, board: "외대앞", lines: ["120"], boardPoint: [127.05, 37.59] as [number, number] } as never;
  hits = 0;
  assert.equal((await p.fetch(ride))[0]!.line, "120");
  assert.equal(hits, 2);
  assert.equal(busUsage().calls, 2);
  // 정류장 목록은 기억해서 두 번째부터는 1번만
  hits = 0;
  await busBoard(127.05, 37.59, "k", base);
  await busBoard(127.05, 37.59, "k", base);
  // 정류장 목록은 기억 (1번), 도착 정보도 1분 기억 (1번)
  assert.equal(hits, 2);
  quota = true;
  hits = 0;
  const err = await p.fetch(ride).catch((e) => e);
  assert.ok(err instanceof QuotaError);
  assert.equal(realtimeReason(err), "오늘 버스 조회 한도 초과 (자정에 풀림)");
  assert.ok(busUsage().blockedUntil);
  // 막힌 동안은 서버에 가지 않는다
  await assert.rejects(p.fetch(ride), QuotaError);
  // 1분 안이면 기억해 둔 도착 정보로 (호출 없음), 다른 정류장은 막혀서 바로 실패
  assert.equal((await busBoard(127.05, 37.59, "k", base))?.lines[0]?.line, "120");
  await assert.rejects(busBoard(127.2, 37.7, "k", base), QuotaError);
  assert.equal(hits, 1);
  quota = false;
  // 2026-11-06 11:06 KST → 다음 날 0시 KST = 2026-11-06T15:00Z
  assert.equal(new Date(nextKstMidnight(Date.parse("2026-11-06T02:06:00Z"))).toISOString(), "2026-11-06T15:00:00.000Z");
  assert.equal(new Date(nextKstMidnight(Date.parse("2026-11-06T16:00:00Z"))).toISOString(), "2026-11-07T15:00:00.000Z");
});

test("정류장에서 멀수록 덜 자주, 위치가 안 오면 5분", async () => {
  const { pollInterval, POLL_MS, BUS_POLL_MS } = await import("./realtime.js");
  const { Navigator } = await import("./navigation.js");
  const nav = new Navigator();
  const ride = { kind: "bus" as const, board: "외대앞", lines: ["120"], boardPoint: [127.0, 37.5] as [number, number] } as never;
  const now = Date.now();
  assert.equal(pollInterval(nav, ride, now), 5 * 60_000);
  nav.lastKnownPosition = { lon: 127.0, lat: 37.501, ts: now }; // 약 110m
  assert.equal(pollInterval(nav, ride, now), BUS_POLL_MS); // 버스는 정류장 근처에서도 1분
  assert.equal(BUS_POLL_MS, 60_000);
  assert.equal(pollInterval(nav, { ...(ride as object), kind: "subway" } as never, now), POLL_MS);
  nav.lastKnownPosition = { lon: 127.0, lat: 37.51, ts: now }; // 약 1.1km
  assert.equal(pollInterval(nav, ride, now), 60_000);
  nav.lastKnownPosition = { lon: 127.0, lat: 37.6, ts: now }; // 약 11km
  assert.equal(pollInterval(nav, ride, now), 180_000);
  nav.lastKnownPosition = { lon: 127.0, lat: 37.501, ts: now - 11 * 60_000 };
  assert.equal(pollInterval(nav, ride, now), 5 * 60_000);
});

test("안경이 안 붙어 있으면 길안내 중이어도 실시간 조회를 안 한다", async () => {
  const { startRealtimePoller } = await import("./realtime.js");
  const { Navigator } = await import("./navigation.js");
  const nav = new Navigator();
  const { readFileSync } = await import("node:fs");
  const { parseTransit } = await import("./kakao.js");
  const { rideStep } = await import("./transit.js");
  // 2026-11-04 실제 카카오 대중교통 응답 (버스 421 구간)
  const raw = JSON.parse(readFileSync(new URL("./fixtures/kakao-transit-sample.json", import.meta.url), "utf8"));
  const place = { name: "x", address: "", x: 127, y: 37.5 };
  nav.start({ from: place, to: place, route: { totalDistance: 1, totalTime: 1, steps: [] }, guide: [rideStep(parseTransit(raw).routes[0]!.legs[2]!)], mode: "transit", startedBy: "t" });
  let calls = 0;
  let on = false;
  const stop = startRealtimePoller(nav, [{ name: "fake", supports: () => true, fetch: async () => (calls++, []) }], () => {}, () => on);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(calls, 0);
  on = true;
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(calls, 1);
  stop();
});
