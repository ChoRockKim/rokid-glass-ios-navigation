import { test } from "node:test";
import assert from "node:assert/strict";
import { RouteTracker } from "./tracking.js";
import { Navigator } from "./navigation.js";
import { parsePositions } from "./api.js";
import type { LonLat, WalkRoute } from "./kakao.js";

// 위도 0.001° ≈ 110.5m, 경도 0.001° ≈ 88m (위도 37.5 기준)
// 북쪽 220m → 서쪽 176m (좌회전)
const north: LonLat[] = [[127, 37.5], [127, 37.501], [127, 37.502]];
const west: LonLat[] = [[127, 37.502], [126.999, 37.502], [126.998, 37.502]];

const route: WalkRoute = {
  totalDistance: 397,
  totalTime: 400,
  steps: [
    { guidance: "A역 1번 출구 진출 후 221m 이동", distance: 221, time: 221, x: 127, y: 37.5, points: north },
    { guidance: "B교차로에서 C사거리까지 176m 이동(서쪽로)", distance: 176, time: 176, x: 127, y: 37.502, points: west },
  ],
};
const place = { name: "C사거리", address: "", x: 126.998, y: 37.502 };

test("RouteTracker: 투영과 단계 경계", () => {
  const t = new RouteTracker([{ points: north }, { points: west }]);
  assert.ok(Math.abs(t.length - 397) < 3, `length=${t.length}`);
  assert.ok(Math.abs(t.stepEnd[0]! - 221) < 2);
  // 북쪽 구간 중간에서 동쪽으로 10m 벗어난 점
  const p = t.project([127 + 10 / 88_300, 37.501], 0)!;
  assert.ok(Math.abs(p.s - 110.5) < 2, `s=${p.s}`);
  assert.ok(Math.abs(p.offset - 10) < 1, `offset=${p.offset}`);
  assert.equal(t.stepAt(100, 12), 0);
  assert.equal(t.stepAt(215, 12), 1); // 회전 지점 12m 이내면 다음 단계
  assert.equal(t.stepAt(390, 12), 2); // 도착
});

test("Navigator: 위치로 단계 자동 진행, 남은 거리, 이탈", () => {
  let now = 1_000_000;
  const nav = new Navigator(() => now);
  const msgs: string[] = [];
  nav.onChange((m) => msgs.push(m.type === "step" ? `${m.index}:${m.remaining === null ? "-" : Math.round(m.remaining)}${m.offRoute ? ":OFF" : ""}` : m.type));
  nav.start({ from: place, to: place, route, startedBy: "t" });
  assert.deepEqual(msgs, ["0:-"]);

  nav.updatePositions([{ lon: 127, lat: 37.5005, acc: 5, ts: 1 }]); // 55m 지점
  const m1 = nav.snapshot();
  assert.equal(m1.type === "step" && m1.index, 0);
  assert.ok(m1.type === "step" && Math.abs(m1.remaining! - 166) < 3);
  assert.ok(m1.type === "step" && m1.line2.includes("166m") || m1.type === "step" && m1.line2.includes("165m"), JSON.stringify(m1));

  nav.updatePositions([{ lon: 127, lat: 37.5019, acc: 5, ts: 2 }]); // 회전 11m 전 → 다음 단계
  const m2 = nav.snapshot();
  assert.equal(m2.type === "step" && m2.index, 1);
  assert.equal(m2.type === "step" && m2.line1.startsWith("←"), true);

  // 정확도 나쁜 점은 버림
  assert.equal(nav.updatePositions([{ lon: 0, lat: 0, acc: 200, ts: 3 }]).reason, "inaccurate");
  // 과거 시각 점은 버림
  assert.equal(nav.updatePositions([{ lon: 127, lat: 37.5, acc: 5, ts: 1 }]).reason, "stale");

  // 경로에서 남쪽으로 100m 벗어남
  const r = nav.updatePositions([{ lon: 126.999, lat: 37.5011, acc: 5, ts: 4 }]);
  assert.equal(r.offRoute, true);
  assert.equal(r.offRouteCount, 1);
  const m3 = nav.snapshot();
  assert.equal(m3.type === "step" && m3.offRoute, true);
  assert.equal(m3.type === "step" && m3.line1, "⚠ 경로를 벗어났습니다");

  // 복귀 후 도착
  nav.updatePositions([{ lon: 126.99805, lat: 37.502, acc: 5, ts: 5 }]);
  assert.equal(nav.snapshot().type, "arrived");
  now += 1;
});

test("Navigator: 수동 next 는 잠시 위치보다 우선", () => {
  let now = 0;
  const nav = new Navigator(() => now);
  nav.start({ from: place, to: place, route, startedBy: "t" });
  nav.updatePositions([{ lon: 127, lat: 37.5005, acc: 5, ts: 1 }]);
  nav.move(1);
  nav.updatePositions([{ lon: 127, lat: 37.5006, acc: 5, ts: 2 }]); // 아직 첫 단계 위치
  const m = nav.snapshot();
  assert.equal(m.type === "step" && m.index, 1);
  now += 61_000; // 홀드 만료 후에는 위치를 따른다
  nav.updatePositions([{ lon: 127, lat: 37.5007, acc: 5, ts: 3 }]);
  const m2 = nav.snapshot();
  assert.equal(m2.type === "step" && m2.index, 0);
});

test("parsePositions: Overland / 단순 / OwnTracks", () => {
  const overland = parsePositions({
    locations: [
      { type: "Feature", geometry: { type: "Point", coordinates: [127.01, 37.5] }, properties: { timestamp: "2026-11-04T05:00:00Z", horizontal_accuracy: 8 } },
      { type: "Feature", geometry: { type: "Point", coordinates: [127.02, 37.5] }, properties: { timestamp: "2026-11-04T05:01:00Z", action: "visit" } },
    ],
  })!;
  assert.equal(overland.length, 1);
  assert.deepEqual(overland[0], { lon: 127.01, lat: 37.5, acc: 8, ts: Date.parse("2026-11-04T05:00:00Z") });

  const simple = parsePositions({ lat: "37.5", lon: "127.0", acc: 12 })!;
  assert.equal(simple[0]!.lat, 37.5);
  assert.equal(simple[0]!.acc, 12);

  const owntracks = parsePositions({ _type: "location", lat: 37.5, lon: 127, acc: 5, tst: 1_700_000_000 })!;
  assert.equal(owntracks[0]!.ts, 1_700_000_000_000);

  assert.equal(parsePositions({ foo: 1 }), null);
  assert.deepEqual(parsePositions({ locations: [] }), []);
});
