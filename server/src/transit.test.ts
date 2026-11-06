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
  assert.equal(bus.line1, "[버스] 421 탑승 · 제기역약령시장");
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
  assert.equal(m.type === "step" && m.line1, "[버스] 421 3분 · 7분 후");
  assert.equal(m.type === "step" && m.ride?.boarded, false);

  // 정류장에서 300m 진행 → 탑승 중
  const pts = legs[2]!.points;
  nav.updatePositions([{ lon: pts[10]![0], lat: pts[10]![1], acc: 5, ts: 1 }]);
  m = nav.snapshot();
  assert.equal(m.type === "step" && m.ride?.boarded, true);
  assert.equal(m.type === "step" && m.line1, "[버스] 421 탑승 중");
  assert.ok(m.type === "step" && /^성동구청 하차 · 약 \d정거장$/.test(m.line2), m.type === "step" ? m.line2 : "");
  assert.equal(nav.upcomingRide(), null); // 탄 뒤에는 (다음 환승이 없으면) 폴링 안 함

  // 오래된 실시간 정보는 안 씀
  now += 100_000;
  nav.stop();
});

test("정류장 보드: 탈 정류장 근처에서 내 버스(강조)와 나머지(약하게), 타면 사라짐", () => {
  let now = 0;
  const nav = new Navigator(() => now);
  const legs = parseTransit(raw).routes[0]!.legs;
  const guide: GuideStep[] = [rideStep(legs[2]!)];
  const place = { name: "성동구청", address: "", x: 0, y: 0 };
  nav.start({ from: place, to: place, route: { totalDistance: 1, totalTime: 1, steps: [] }, guide, mode: "transit", startedBy: "t" });
  nav.setArrivals(nav.upcomingRide()!.step, [
    { line: "421", etaSec: 400, message: "6분40초후", mine: true },
    { line: "421", etaSec: 130, message: "2분10초후", mine: true },
    { line: "2014", etaSec: 50, message: "곧 도착", mine: false },
    { line: "2014", etaSec: 900, message: "15분후", mine: false },
    { line: "N62", etaSec: null, message: "운행대기", mine: false },
  ]);
  // 위치를 모르면 보드 없음
  let m = nav.snapshot();
  assert.ok(m.type === "step" && !m.stop && m.line1 === "[버스] 421 3분 · 7분 후"); // 나머지 버스는 안내 문구에 안 섞임
  // 정류장 바로 앞
  const p0 = legs[2]!.points[0]!;
  nav.updatePositions([{ lon: p0[0], lat: p0[1] + 0.0003, acc: 5, ts: 1 }]);
  m = nav.snapshot();
  assert.ok(m.type === "step" && m.stop);
  if (m.type === "step" && m.stop) {
    assert.deepEqual(m.stop.mine, [{ line: "421", times: ["3분", "7분"], etas: [130, 400] }]);
    assert.deepEqual(m.stop.others, [{ line: "2014", times: ["곧 도착"], etas: [50] }, { line: "N62", times: ["운행대기"], etas: [null] }]);
  }
  // 타고 300m 가면 보드 없음
  const pts = legs[2]!.points;
  nav.updatePositions([{ lon: pts[10]![0], lat: pts[10]![1], acc: 5, ts: 2 }]);
  m = nav.snapshot();
  assert.ok(m.type === "step" && !m.stop);
});

test("실시간 실패: 정류장 근처면 이유를 보드로, 다시 받으면 지움", () => {
  let now = 0;
  const nav = new Navigator(() => now);
  const legs = parseTransit(raw).routes[0]!.legs;
  const guide: GuideStep[] = [rideStep(legs[2]!)];
  const place = { name: "성동구청", address: "", x: 0, y: 0 };
  nav.start({ from: place, to: place, route: { totalDistance: 1, totalTime: 1, steps: [] }, guide, mode: "transit", startedBy: "t" });
  const p0 = legs[2]!.points[0]!;
  nav.updatePositions([{ lon: p0[0], lat: p0[1], acc: 5, ts: 1 }]);
  const step = nav.upcomingRide()!.step;
  nav.setArrivalsError(step, "실시간 정보 없음 (서버 응답 없음)");
  let m = nav.snapshot();
  assert.ok(m.type === "step" && m.stop?.error === "실시간 정보 없음 (서버 응답 없음)" && m.ride?.error === "실시간 정보 없음 (서버 응답 없음)");
  nav.setArrivals(step, [{ line: "421", etaSec: 130, message: "2분10초후", mine: true }]);
  m = nav.snapshot();
  assert.ok(m.type === "step" && !m.stop?.error && !m.ride?.error && m.stop?.mine.length === 1);
});

test("하차 알림: 탑승 중 하차 지점이 가까워지면 다음 → 이번 정류장", () => {
  let now = 0;
  const nav = new Navigator(() => now);
  const legs = parseTransit(raw).routes[0]!.legs;
  const guide: GuideStep[] = [rideStep(legs[2]!)];
  const place = { name: "성동구청", address: "", x: 0, y: 0 };
  nav.start({ from: place, to: place, route: { totalDistance: 1, totalTime: 1, steps: [] }, guide, mode: "transit", startedBy: "t" });
  const pts = legs[2]!.points;
  const at = (i: number) => { nav.updatePositions([{ lon: pts[i]![0], lat: pts[i]![1], acc: 5, ts: ++now }]); return nav.snapshot(); };
  // 출발 직후: 알림 없음
  const m = at(10);
  assert.ok(m.type === "step" && m.ride?.boarded && !m.ride.alightAlert);
  // 끝까지 가며: 알림 없음 → 다음 정류장 → 이번 정류장 (한 번 뜨면 계속)
  const seq: string[] = [];
  const texts = new Set<string>();
  for (let i = 11; i < pts.length; i++) {
    const s = at(i);
    if (s.type !== "step") break; // 하차 지점(12m 안)이면 도착
    seq.push(s.ride?.alightAlert ?? "-");
    texts.add(s.line1);
  }
  const order = seq.filter((x, i) => x !== seq[i - 1]);
  assert.deepEqual(order, ["-", "soon", "now"], seq.join(","));
  assert.ok(texts.has("[버스] 다음 정류장에서 하차") && texts.has("[버스] 이번 정류장에서 하차"));
});

test("같은 정류장 환승: 내려서 서 있으면 다음 버스 단계로 넘어가고, 위치가 흔들려도 하차 알림으로 돌아가지 않는다", async () => {
  const { RIDE_ADVANCE_M } = await import("./navigation.js");
  const { distanceM } = await import("./guide.js");
  let now = 0;
  const nav = new Navigator(() => now);
  const legs = parseTransit(raw).routes[0]!.legs;
  // 2026-11-06 실사용: 120 하차 → 같은 정류장에서 241 (중간 도보 없음). 같은 버스 구간을 두 번 이어 붙여 흉내
  const first = rideStep(legs[2]!);
  const pts = legs[2]!.points;
  const second = { ...rideStep(legs[2]!), points: [pts[pts.length - 1]!, [pts[pts.length - 1]![0] + 0.01, pts[pts.length - 1]![1]] as [number, number]] };
  second.ride = { ...second.ride!, boardPoint: second.points[0]!, board: first.ride!.alight };
  const place = { name: "x", address: "", x: 0, y: 0 };
  nav.start({ from: place, to: place, route: { totalDistance: 1, totalTime: 1, steps: [] }, guide: [first, second], mode: "transit", startedBy: "t" });
  const go = (p: [number, number]) => { nav.updatePositions([{ lon: p[0], lat: p[1], acc: 5, ts: ++now }]); return nav.snapshot(); };
  for (let i = 10; i < pts.length - 3; i++) go(pts[i] as [number, number]);
  // 하차 지점 약 25m 앞 (정류장이 경로선 끝에 딱 닿지 않음) 에서 멈춤 → 다음 버스 단계
  const end = pts[pts.length - 1]!;
  let k = pts.length - 2;
  while (k > 0 && distanceM(pts[k]!, end) < 25) k--;
  const f = 1 - 25 / Math.max(25, distanceM(pts[k]!, end));
  const stopAt: [number, number] = [pts[k]![0] + (end[0] - pts[k]![0]) * Math.max(0, f), pts[k]![1] + (end[1] - pts[k]![1]) * Math.max(0, f)];
  assert.ok(RIDE_ADVANCE_M > 25);
  let m = go(stopAt);
  assert.ok(m.type === "step" && m.index === 1 && !m.ride?.alightAlert, JSON.stringify(m).slice(0, 200));
  // 서 있는 동안 위치가 경계 근처에서 흔들려도 (뒤로 15m) 241 단계 그대로
  const back15: [number, number] = [stopAt[0] + (pts[k]![0] - end[0]) * 0.3, stopAt[1] + (pts[k]![1] - end[1]) * 0.3];
  for (let i = 0; i < 6; i++) {
    m = go(i % 2 ? stopAt : back15);
    assert.ok(m.type === "step" && m.index === 1, `흔들림 ${i}: ${m.type === "step" ? m.line1 : m.type}`);
  }
});

test("최근 목적지: 같은 이름은 하나로, 최근 순, 현재 위치 제외, 최대 8", async () => {
  const { Recent, RECENT_MAX } = await import("./recent.js");
  const r = new Recent(null);
  r.add({ name: "현재 위치", address: "", x: 0, y: 0 });
  for (let i = 0; i < 10; i++) r.add({ name: `곳${i}`, address: "", x: i, y: 0 });
  r.add({ name: "곳3", address: "새 주소", x: 3, y: 0 });
  const names = r.list().map((p) => p.name);
  assert.equal(names.length, RECENT_MAX);
  assert.equal(names[0], "곳3");
  assert.equal(r.get("곳3")!.address, "새 주소");
  assert.ok(!names.includes("현재 위치"));
});
