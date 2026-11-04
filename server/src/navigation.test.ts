import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRouteArgs, Navigator } from "./navigation.js";
import { parseWalk, type LonLat, type Step } from "./kakao.js";
import {
  buildGuide,
  classifyTurn,
  countCrossings,
  formatDistance,
  parseAt,
  parseRoad,
  parseTarget,
  turnAngle,
} from "./guide.js";

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

test("guidance 문구 파싱 (2026-11-04 실제 응답 문구)", () => {
  const g1 = "외국어대교차로에서 회기역앞교차로까지 795m 이동(이문로)";
  assert.equal(parseAt(g1), "외국어대교차로");
  assert.equal(parseTarget(g1), "회기역앞교차로");
  assert.equal(parseRoad(g1), "이문로");
  const g2 = "잼곱창 앞에서 서울경찰청 제2기동단 23기동대까지 433m 이동(고산자로)";
  assert.equal(parseAt(g2), "잼곱창");
  assert.equal(parseTarget(g2), "서울경찰청 제2기동단 23기동대");
  assert.equal(parseTarget("도선사거리까지 627m 이동(고산자로)"), "도선사거리");
  assert.equal(parseTarget("456m 이동(제기로)"), null);
  assert.equal(parseAt("456m 이동(제기로)"), null);
  assert.equal(countCrossings("블루클럽 앞에서 바나프레소까지 2개의 횡단보도 이용"), 2);
  assert.equal(countCrossings("떡전교사거리에서 횡단보도 이용"), 1);
  assert.equal(countCrossings("538m 이동(테헤란로)"), 0);
});

// 위도 0.001° ≈ 111m. 북쪽으로 가다가 서쪽(왼쪽)으로
const north: LonLat[] = [[127, 37.5], [127, 37.501], [127, 37.502]];
const west: LonLat[] = [[127, 37.502], [126.999, 37.502], [126.998, 37.502]];
const east: LonLat[] = [[127, 37.502], [127.001, 37.502], [127.002, 37.502]];

test("turnAngle / classifyTurn", () => {
  const left = turnAngle(north, west)!;
  assert.ok(left < -80 && left > -100, `left=${left}`);
  assert.equal(classifyTurn(left), "left");
  assert.equal(classifyTurn(turnAngle(north, east)), "right");
  assert.equal(classifyTurn(turnAngle(north, [[127, 37.502], [127, 37.503]])), "straight");
  assert.equal(classifyTurn(-40), "slight-left");
  assert.equal(classifyTurn(170), "uturn");
});

const step = (guidance: string, distance: number, points: LonLat[]): Step => ({
  guidance,
  distance,
  time: distance,
  x: points[0]![0],
  y: points[0]![1],
  points,
});

test("buildGuide: 횡단보도·짧은 단계 병합 + 회전", () => {
  const guide = buildGuide([
    step("A역 1번 출구 진출 후 222m 이동", 222, north),
    step("B교차로에서 횡단보도 이용", 20, [[127, 37.502], [126.9998, 37.502]]),
    step("C까지 10m 이동", 10, [[126.9998, 37.502], [126.9997, 37.502]]),
    step("B교차로에서 D사거리까지 300m 이동(서쪽로)", 300, [[126.9997, 37.502], [126.999, 37.502], [126.998, 37.502]]),
    step("E역 2번 출구로 진입하여 역사 내 이동", 30, [[126.998, 37.502], [126.998, 37.5021]]),
  ]);
  assert.equal(guide.length, 2);
  const [g1, g2] = guide;
  assert.equal(g1!.turn, "start");
  assert.equal(g2!.turn, "left");
  assert.equal(g2!.at, "B교차로");
  assert.equal(g2!.target, "D사거리");
  assert.equal(g2!.crossings, 1);
  assert.equal(g2!.distance, 20 + 10 + 300 + 30); // 끝에 남은 짧은 단계는 마지막에 붙음
  assert.equal(g2!.raw.length, 4);
  assert.equal(g2!.line1, "← B교차로에서 좌회전 · 횡단보도 1");
  assert.equal(g2!.line2, "D사거리까지 360m · 서쪽로");
});

const sample = {
  status: "OK",
  route: {
    properties: { totalDistance: 314, totalTime: 323 },
    legs: [
      {
        steps: [
          { path: { points: north }, properties: { distance: 96, guidance: "강남역 1번 출구까지 역사 내 이동", time: 100, x: 127, y: 37.5 } },
          { path: { points: west }, properties: { distance: 218, guidance: "강남역 1번 출구 진출 후 218m 이동(테헤란로)", time: 223, x: 127, y: 37.502 } },
        ],
      },
    ],
  },
};

test("parseWalk + Navigator", () => {
  const route = parseWalk(sample);
  assert.equal(route.steps.length, 2);
  assert.equal(route.steps[0]!.points.length, 3);
  const nav = new Navigator();
  const seen: string[] = [];
  nav.onChange((m) => seen.push(m.type));
  const place = { name: "x", address: "", x: 0, y: 0 };
  nav.start({ from: place, to: { ...place, name: "선릉역" }, route, startedBy: "U1" });
  const first = nav.snapshot();
  assert.equal(first.type, "step");
  if (first.type === "step") assert.equal(first.total, 2);
  nav.move(1);
  const second = nav.snapshot();
  if (second.type === "step") assert.equal(second.turn, "left");
  nav.move(1);
  nav.move(1); // 도착 이후로는 안 넘어감
  assert.equal(nav.snapshot().type, "arrived");
  nav.move(-1);
  assert.equal(nav.snapshot().type, "step");
  nav.stop();
  assert.equal(nav.snapshot().type, "idle");
  assert.deepEqual(seen, ["step", "step", "arrived", "arrived", "step", "idle"]);
});
