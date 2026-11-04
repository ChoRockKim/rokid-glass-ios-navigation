import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTransit } from "./kakao.js";
import { rideStep, summarizeOption } from "./transit.js";
import { Navigator, arrivalText, arrivalsText } from "./navigation.js";
import { parseEta, shortSubwayMsg, stationName, xmlItems } from "./realtime.js";
import type { GuideStep } from "./guide.js";

// 2026-11-04 실제 카카오 대중교통 응답 중 1개 (외대앞 → 1호선 → 제기동 → 도보 → 421번 → 성동구청)
const raw = JSON.parse(readFileSync(new URL("./fixtures/kakao-transit-sample.json", import.meta.url), "utf8"));

test("parseTransit + summarizeOption", () => {
  const { routes, landingUrl } = parseTransit(raw);
  assert.ok(landingUrl?.startsWith("https://map.kakao.com"));
  const r = routes[0]!;
  assert.deepEqual(r.legs.map((l) => l.kind), ["SUBWAY", "WALKING", "BUS"]);
  assert.deepEqual(r.legs[2]!.lines, ["421"]);
  assert.equal(r.legs[2]!.stops[0], "제기역약령시장");
  assert.equal(summarizeOption(r, 0), "① 32분 · 환승 1 · 1,550원  1호선 외대앞→제기동 / 421번 제기역약령시장→성동구청");
});

test("rideStep 문구", () => {
  const bus = rideStep(parseTransit(raw).routes[0]!.legs[2]!);
  assert.equal(bus.turn, "bus");
  assert.equal(bus.line1, "🚌 421 탑승 · 제기역약령시장");
  assert.equal(bus.line2, "성동구청 하차 · 4정거장");
});

test("실시간 문구 파싱", () => {
  assert.equal(parseEta("3분12초후[2번째 전]"), 192);
  assert.equal(parseEta("5분후[3번째 전]"), 300);
  assert.equal(parseEta("곧 도착"), 0);
  assert.equal(parseEta("전역 도착"), 0);
  assert.equal(parseEta("운행종료"), null);
  // 2026-11-04 서울 실시간 지하철 실제 응답 문구
  assert.equal(shortSubwayMsg("[6]번째 전역 (창동)"), "6역 전");
  assert.equal(shortSubwayMsg("외대앞 도착"), "도착");
  assert.equal(parseEta("외대앞 도착"), 0);
  assert.equal(stationName("왕십리(성동구청)"), "왕십리");
  assert.equal(stationName("청량리(서울시립대입구)"), "청량리");
  assert.deepEqual(xmlItems("<r><itemList><rtNm>421</rtNm><arrmsg1>3분후</arrmsg1></itemList></r>", "itemList"), [{ rtNm: "421", arrmsg1: "3분후" }]);
  assert.equal(arrivalText({ line: "421", etaSec: 200, message: "" }), "421 4분 후");
  assert.equal(arrivalText({ line: "421", etaSec: 30, message: "" }), "421 곧 도착");
  assert.equal(arrivalsText([{ line: "1호선", etaSec: 0, message: "도착" }, { line: "1호선", etaSec: null, message: "6역 전" }]), "1호선 곧 도착 · 6역 전");
  assert.equal(arrivalsText([{ line: "421", etaSec: 100, message: "" }, { line: "141", etaSec: 300, message: "" }]), "421 2분 후 · 141 5분 후");
});

test("upcomingRide: 정류장까지 걷는 단계가 여러 개여도 첫 탑승 구간을 찾는다", () => {
  const nav = new Navigator(() => 0);
  const legs = parseTransit(raw).routes[0]!.legs; // SUBWAY, WALKING, BUS
  const walk = { ...rideStep(legs[0]!), ride: undefined, turn: "walk" as const, points: legs[1]!.points };
  const guide: GuideStep[] = [walk, { ...walk }, rideStep(legs[2]!)];
  const place = { name: "x", address: "", x: 0, y: 0 };
  nav.start({ from: place, to: place, route: { totalDistance: 1, totalTime: 1, steps: [] }, guide, mode: "transit", startedBy: "t" });
  assert.equal(nav.upcomingRide()?.index, 2);
});

test("Navigator: 버스 구간 대기 → 실시간 표시 → 탑승 중", () => {
  let now = 0;
  const nav = new Navigator(() => now);
  const legs = parseTransit(raw).routes[0]!.legs;
  const guide: GuideStep[] = [rideStep(legs[2]!)];
  const place = { name: "성동구청", address: "", x: 0, y: 0 };
  nav.start({ from: place, to: place, route: { totalDistance: 1, totalTime: 1, steps: [] }, guide, mode: "transit", startedBy: "t" });

  const up = nav.upcomingRide();
  assert.equal(up?.index, 0);
  nav.setArrivals(up!.step, [
    { line: "421", etaSec: 400, message: "6분40초후" },
    { line: "421", etaSec: 130, message: "2분10초후" },
  ]);
  let m = nav.snapshot();
  assert.equal(m.type === "step" && m.line1, "🚌 421 3분 · 7분 후");
  assert.equal(m.type === "step" && m.ride?.boarded, false);

  // 정류장에서 300m 진행 → 탑승 중
  const pts = legs[2]!.points;
  nav.updatePositions([{ lon: pts[10]![0], lat: pts[10]![1], acc: 5, ts: 1 }]);
  m = nav.snapshot();
  assert.equal(m.type === "step" && m.ride?.boarded, true);
  assert.equal(m.type === "step" && m.line1, "🚌 421 탑승 중");
  assert.ok(m.type === "step" && /^성동구청 하차 · 약 \d정거장$/.test(m.line2), m.type === "step" ? m.line2 : "");
  assert.equal(nav.upcomingRide(), null); // 탄 뒤에는 (다음 환승이 없으면) 폴링 안 함

  // 오래된 실시간 정보는 안 씀
  now += 100_000;
  nav.stop();
});
