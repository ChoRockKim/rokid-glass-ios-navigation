// 버스 정류장 점: 카카오에서 찾은 정류장을 경로선 위에 놓고, 탄 뒤 "다음 정류장"과 남은 정거장을 정확히
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";

const raw = JSON.parse(readFileSync(new URL("./fixtures/kakao-transit-sample.json", import.meta.url), "utf8"));
let kakao: Server;
const queries: string[] = [];
before(async () => {
  let pts: [number, number][] = [];
  kakao = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    const q = u.searchParams.get("query")!;
    queries.push(q);
    res.setHeader("content-type", "application/json");
    const mid = pts[Math.floor(pts.length / 2)]!;
    // 같은 이름 반대편 정류장(경로선에서 먼 것)과 경로선 위 정류장, 그리고 정류장이 아닌 같은 이름 가게
    res.end(JSON.stringify({ documents: [
      { place_name: q, category_name: "교통,수송 > 교통시설 > 버스 > 버스정류장", x: String(mid[0] + 0.01), y: String(mid[1]) },
      { place_name: q, category_name: "교통,수송 > 교통시설 > 버스 > 버스정류장", x: String(mid[0] + 0.00005), y: String(mid[1]) },
      { place_name: `${q} 약국`, category_name: "의료,건강 > 약국", x: String(mid[0]), y: String(mid[1]) },
    ] }));
  });
  await new Promise<void>((r) => kakao.listen(0, r));
  process.env.KAKAO_BASE = `http://127.0.0.1:${(kakao.address() as { port: number }).port}`;
  // kakao.ts 는 불러올 때 KAKAO_BASE 를 읽는다 → 주소를 정한 뒤에 불러온다
  const { parseTransit } = await import("./kakao.js");
  pts = parseTransit(raw).routes[0]!.legs[2]!.points as [number, number][];
});
after(() => kakao.close());

test("카카오 정류장 찾기: 버스정류장 분류만, 경로선에 가까운 것", async () => {
  const { kakaoStopLocator } = await import("./transit.js");
  const { parseTransit } = await import("./kakao.js");
  const leg = parseTransit(raw).routes[0]!.legs[2]!;
  const logs: string[] = [];
  const found = await kakaoStopLocator("k", (m) => logs.push(m))({ kind: "bus", stops: leg.stops, lines: leg.lines }, leg.points);
  assert.equal(found.length, leg.stops.length);
  assert.deepEqual(found[0], { lon: leg.points[0]![0], lat: leg.points[0]![1] }); // 탑승은 경로선 시작
  const mid = leg.points[Math.floor(leg.points.length / 2)]!;
  assert.ok(Math.abs(found[1]!.lon - (mid[0] + 0.00005)) < 1e-9, "경로선에 붙은 쪽");
  assert.equal(queries.length, leg.stops.length - 2); // 가운데 정류장만 검색
  assert.ok(logs.some((l) => /5\/5 찾음/.test(l)), logs.join("\n"));
});

test("탄 뒤: 다음 정류장 이름, 지난 정류장 수로 남은 정거장, 하차 알림은 정거장 수로", async () => {
  const { Navigator } = await import("./navigation.js");
  const { parseTransit } = await import("./kakao.js");
  const { rideStep } = await import("./transit.js");
  let now = 0;
  const nav = new Navigator(() => now);
  const leg = parseTransit(raw).routes[0]!.legs[2]!; // 421: 제기역약령시장 → … → 성동구청 (5곳)
  const pts = leg.points;
  // 정류장을 경로선 위 1/4 지점마다 있는 것으로 (가운데 하나는 못 찾음)
  const cum = [0];
  const { distanceM } = await import("./guide.js");
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + distanceM(pts[i - 1]!, pts[i]!));
  const idxAt = (f: number) => cum.findIndex((c) => c >= f * cum[cum.length - 1]!);
  nav.stopLocator = async (r) => r.stops.map((_, k) => (k === 2 ? null : { lon: pts[idxAt(k / 4)]![0], lat: pts[idxAt(k / 4)]![1] }));
  const maps: { stops?: { name: string }[] }[] = [];
  nav.onMap((m) => { if (m.type === "map-route") maps.push(m); });
  const place = { name: "x", address: "", x: 0, y: 0 };
  nav.start({ from: place, to: place, route: { totalDistance: 1, totalTime: 1, steps: [] }, guide: [rideStep(leg)], mode: "transit", startedBy: "t" });
  await new Promise((r) => setTimeout(r, 10));
  const last = maps[maps.length - 1]!;
  assert.deepEqual(last.stops!.map((s) => s.name), ["제기역약령시장", "동대문구청.용두동주민센터", "도선사거리", "성동구청"]);
  const at = (i: number) => { nav.updatePositions([{ lon: pts[i]![0], lat: pts[i]![1], acc: 5, ts: ++now }]); return nav.snapshot(); };
  // 1/4 지점을 막 지나 1/2 사이: 다음 = 도선사거리(마장축산물시장은 못 찾아 건너뜀), 남은 2정거장
  let m = at(Math.floor((idxAt(0.25) + idxAt(0.5)) / 2) + 1);
  assert.ok(m.type === "step" && m.ride?.boarded);
  assert.equal(m.ride!.nextStop, "도선사거리");
  assert.equal(m.ride!.stopsLeft, 2);
  assert.equal(m.line2, "다음 도선사거리 · 성동구청 하차 · 2정거장");
  assert.ok(!m.ride!.alightAlert);
  // 도선사거리를 지나면: 다음이 하차 → "다음 정류장에서 하차"
  m = at(Math.min(pts.length - 1, idxAt(0.75) + 3));
  if (m.type === "step" && m.remaining! > 150) {
    assert.equal(m.ride!.alightAlert, "soon");
    assert.equal(m.line2, "성동구청 하차 · 1정거장");
  }
});
