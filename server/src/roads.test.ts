import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error 타입 없음 (테스트 전용)
import geojsonvt from "geojson-vt";
// @ts-expect-error 타입 없음 (테스트 전용)
import vtpbf from "vt-pbf";
import { nearestBuildings, omtKind, roadsFromTile, simplifyBuilding } from "./roads.js";

// OpenMapTiles 와 같은 레이어 이름·속성으로 z14 타일을 만들어 roadsFromTile 이 읽는지 확인
const Z = 14;
const lon2x = (lon: number) => Math.floor(((lon + 180) / 360) * 2 ** Z);
const lat2y = (lat: number) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z); };

test("roadsFromTile: 도로 종류·건물 윤곽·터널 제외", () => {
  // 타일 한가운데 좌표 (경계에 걸치면 옆 타일로 넘어간다)
  const x0 = lon2x(127.0633), y0 = lat2y(37.5962);
  const lon = ((x0 + 0.5) / 2 ** Z) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y0 + 0.5)) / 2 ** Z))) * 180) / Math.PI;
  const line = (cls: string, extra: Record<string, string> = {}, d = 0) => ({ type: "Feature", properties: { class: cls, ...extra }, geometry: { type: "LineString", coordinates: [[lon - 0.001, lat + d], [lon + 0.001, lat + d]] } });
  const transportation = { type: "FeatureCollection", features: [line("primary"), line("minor", {}, 0.0003), line("path", { subclass: "footway" }, 0.0006), line("service", {}, 0.0009), line("transit", { brunnel: "tunnel" }, 0.0012), line("rail", {}, 0.0015)] };
  const building = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + 0.0002, lat], [lon + 0.0002, lat + 0.0002], [lon, lat + 0.0002], [lon, lat]]] } }] };
  const x = lon2x(lon), y = lat2y(lat);
  const layers: Record<string, unknown> = {};
  for (const [name, fc] of Object.entries({ transportation, building })) layers[name] = new geojsonvt(fc, { maxZoom: Z, indexMaxZoom: Z, tolerance: 0, buffer: 64 }).getTile(Z, x, y);
  const buf = vtpbf.fromGeojsonVt(layers, { version: 2 });
  const r = roadsFromTile(new Uint8Array(buf), x, y, Z, [lon - 0.003, lat - 0.003, lon + 0.003, lat + 0.003]);
  assert.deepEqual(r.kinds, ["major", "road", "path", "service", "rail"]); // transit 터널 제외
  assert.deepEqual(r.major, [true, false, false, false, false]);
  assert.equal(r.buildings.length, 1);
  assert.ok(Math.abs(r.lines[0]![0]![0] - (lon - 0.001)) < 2e-5 && Math.abs(r.lines[0]![0]![1] - lat) < 2e-5, JSON.stringify(r.lines[0]![0]));
  assert.ok(Math.abs(r.buildings[0]![0]![0] - lon) < 2e-5);
});

test("omtKind", () => {
  assert.equal(omtKind("secondary"), "major");
  assert.equal(omtKind("tertiary"), "road");
  assert.equal(omtKind("ferry"), null);
});

test("simplifyBuilding: ㄱ자 건물 → 감싸는 직사각형 4점, 작은 건물은 버림", () => {
  const lon = 127.06, lat = 37.59;
  const m = (x: number, y: number): [number, number] => [lon + x / (111_320 * Math.cos((lat * Math.PI) / 180)), lat + y / 110_540];
  // 30m x 20m 에서 한 귀퉁이(10x10)를 뺀 ㄱ자
  const l = [m(0, 0), m(30, 0), m(30, 20), m(20, 20), m(20, 10), m(0, 10), m(0, 0)];
  const box = simplifyBuilding(l)!;
  assert.equal(box.length, 4);
  const xs = box.map((p) => p[0]).sort(), ys = box.map((p) => p[1]).sort();
  assert.ok(Math.abs(xs[0]! - lon) < 1e-7 && Math.abs(xs[3]! - m(30, 0)[0]) < 1e-7);
  assert.ok(Math.abs(ys[0]! - lat) < 1e-7 && Math.abs(ys[3]! - m(0, 20)[1]) < 1e-7);
  // 45도 돌린 정사각형은 돌린 그대로 (축 정렬 박스로 키우지 않음)
  const d = simplifyBuilding([m(10, 0), m(20, 10), m(10, 20), m(0, 10)])!;
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const side = Math.hypot((d[1]![0] - d[0]![0]) * kx, (d[1]![1] - d[0]![1]) * 110_540);
  assert.ok(Math.abs(side - Math.SQRT2 * 10) < 0.01, String(side)); // 축 정렬이면 20m
  assert.equal(simplifyBuilding([m(0, 0), m(5, 0), m(5, 5), m(0, 5)]), null); // 25㎡
});

test("nearestBuildings: 가까운 순으로 자른다", () => {
  const b = [0.003, 0.001, 0.002].map((d) => [[127 + d, 37.5] as [number, number]]);
  assert.deepEqual(nearestBuildings(b, 127, 37.5, 2).map((r) => r[0]![0]), [127.001, 127.002]);
});
