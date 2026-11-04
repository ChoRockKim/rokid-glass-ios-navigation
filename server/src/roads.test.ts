import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error 타입 없음 (테스트 전용)
import geojsonvt from "geojson-vt";
// @ts-expect-error 타입 없음 (테스트 전용)
import vtpbf from "vt-pbf";
import { omtKind, roadsFromTile } from "./roads.js";

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
