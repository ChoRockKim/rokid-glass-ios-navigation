import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRouteArgs, Navigator, formatDistance } from "./navigation.js";
import { parseWalk } from "./kakao.js";

test("parseRouteArgs", () => {
  assert.deepEqual(parseRouteArgs("강남역 > 선릉역"), { from: "강남역", to: "선릉역" });
  assert.deepEqual(parseRouteArgs("강남역->선릉역"), { from: "강남역", to: "선릉역" });
  assert.deepEqual(parseRouteArgs("서울역 → 남대문시장"), { from: "서울역", to: "남대문시장" });
  assert.deepEqual(parseRouteArgs("강남역에서 선릉역까지"), { from: "강남역", to: "선릉역" });
  assert.equal(parseRouteArgs("선릉역"), null);
});

test("formatDistance", () => {
  assert.equal(formatDistance(538), "538m");
  assert.equal(formatDistance(2118), "2.1km");
});

// 2026-11-04 실제 응답에서 줄인 모양
const sample = {
  status: "OK",
  route: {
    properties: { totalDistance: 314, totalTime: 323 },
    legs: [
      {
        steps: [
          { path: { points: [] }, properties: { distance: 96, guidance: "강남역 1번 출구까지 역사 내 이동", time: 100, x: 127.0279, y: 37.498 } },
          { path: { points: [] }, properties: { distance: 218, guidance: "강남역 1번 출구 진출 후 218m 이동(테헤란로)", time: 223, x: 127.0287, y: 37.4981 } },
        ],
      },
    ],
  },
};

test("parseWalk + Navigator", () => {
  const route = parseWalk(sample);
  assert.equal(route.steps.length, 2);
  const nav = new Navigator();
  const seen: string[] = [];
  nav.onChange((m) => seen.push(m.type));
  const place = { name: "x", address: "", x: 0, y: 0 };
  nav.start({ from: place, to: { ...place, name: "선릉역" }, route, index: 0, startedBy: "U1" });
  assert.equal(nav.snapshot().type, "step");
  nav.move(1);
  nav.move(1);
  nav.move(1); // 도착 이후로는 안 넘어감
  const s = nav.snapshot();
  assert.equal(s.type, "arrived");
  nav.move(-1);
  assert.equal(nav.snapshot().type, "step");
  nav.stop();
  assert.equal(nav.snapshot().type, "idle");
  assert.deepEqual(seen, ["step", "step", "arrived", "arrived", "step", "idle"]);
});
