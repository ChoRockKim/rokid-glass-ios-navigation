// 안정성 패치: 오래된 경로, 정류장 위치 기억, 즐겨찾기 저장 실패, 음성 검색 겹침
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// kakao.ts 는 불러올 때 주소를 읽는다 → 닫힌 포트로 (카카오 호출은 바로 실패)
process.env.KAKAO_BASE = "http://127.0.0.1:9";

test("경로 방치 시간: 시작부터, 위치가 오면 그때부터", async () => {
  const { Navigator } = await import("./navigation.js");
  let now = 1_000_000;
  const nav = new Navigator(() => now);
  assert.equal(nav.idleMs(), null);
  const place = { name: "x", address: "", x: 127, y: 37.5 };
  const step = { turn: "walk", angle: null, at: "", target: "", road: null, distance: 100, time: 60, crossings: 0, line1: "a", line2: "b", raw: [], points: [[127, 37.5], [127, 37.501]] };
  nav.start({ from: place, to: place, route: { totalDistance: 1, totalTime: 1, steps: [] }, guide: [step as never], startedBy: "t" });
  now += 50 * 60_000;
  assert.equal(nav.idleMs(), 50 * 60_000);
  nav.updatePositions([{ lon: 127, lat: 37.5002, acc: 5, ts: now }]);
  now += 10 * 60_000;
  assert.equal(nav.idleMs(), 10 * 60_000);
  nav.stop();
  assert.equal(nav.idleMs(), null);
});

test("정류장 위치 기억: 두 번째부터는 카카오를 안 부르고, 못 찾은 것도 하루 기억, 파일로 남음", async () => {
  const { StopCache, MISS_TTL_MS } = await import("./stopcache.js");
  const { kakaoStopLocator } = await import("./transit.js");
  const dir = mkdtempSync(join(tmpdir(), "stops-"));
  const file = join(dir, "stops.json");
  let now = 0;
  const cache = new StopCache(file, () => now);
  // 카카오 대신: 가짜 서버 없이 routeStops 로 위치를 주고, 카카오 호출은 KAKAO_BASE 가 없어 실패(=null, 기억 안 함)하게
  let routeCalls = 0;
  const routeStops = async () => (routeCalls++, [null, { lon: 127.0, lat: 37.505 }, null, null]);
  const locate = kakaoStopLocator("k", () => {}, routeStops, cache);
  const ride = { kind: "bus" as const, stops: ["A", "B", "C", "D"], lines: ["241"] };
  const line: [number, number][] = [[127.0, 37.5], [127.0, 37.52]];
  const first = await locate(ride, line);
  assert.deepEqual(first[1], { lon: 127.0, lat: 37.505 });
  assert.equal(routeCalls, 1);
  assert.equal(cache.get(StopCache.key("bus", "241", "B"))?.[1], 37.505);
  assert.equal(cache.get(StopCache.key("bus", "241", "C")), undefined); // 오류는 기억 안 함
  cache.set(StopCache.key("bus", "241", "C"), null); // 못 찾음
  const second = await locate(ride, line);
  assert.equal(routeCalls, 1, "다 기억하고 있으면 노선정보도 안 부름");
  assert.deepEqual(second[1], { lon: 127.0, lat: 37.505 });
  assert.equal(second[2], null);
  // 못 찾음은 하루 지나면 다시 찾는다
  now += MISS_TTL_MS + 1;
  assert.equal(cache.get(StopCache.key("bus", "241", "C")), undefined);
  // 파일로 남아 재시작해도 읽힌다
  cache.flush();
  assert.ok(readFileSync(file, "utf8").includes("v2:bus:241:B"));
  assert.equal(new StopCache(file).get(StopCache.key("bus", "241", "B"))?.[0], 127.0);
});

test("즐겨찾기: 디스크 저장이 실패해도 예외 없이 메모리에 반영하고 이유를 남긴다", async () => {
  const { Favorites } = await import("./favorites.js");
  // 부모가 파일이라 폴더를 만들 수 없는 경로 → 쓰기 실패
  const dir = mkdtempSync(join(tmpdir(), "fav-"));
  writeFileSync(join(dir, "file"), "x");
  const f = new Favorites(join(dir, "file", "favorites.json"));
  const fav = f.upsert({ name: "집", category: "", address: "a", place: "p", x: 1, y: 2 });
  assert.equal(fav.name, "집");
  assert.equal(f.list().length, 1);
  assert.ok(f.saveError);
});

test("음성 검색은 한 번에 하나 (고르는 중에 또 오면 거절)", async () => {
  const { createApi } = await import("./api.js");
  const { Navigator } = await import("./navigation.js");
  let release!: (t: string) => void;
  const api = createApi({ nav: new Navigator(), apiToken: "a", kakaoKey: "k", log: () => {}, stt: () => new Promise<string>((r) => (release = r)) });
  const first = api.goVoice(Buffer.alloc(2000));
  assert.match(await api.goVoice(Buffer.alloc(2000)), /앞의 음성 검색을 처리하는 중/);
  release("");
  assert.match(await first, /못 알아들었어요/);
  // 끝나면 다시 받는다
  release = () => {};
  const again = api.goVoice(Buffer.alloc(2000));
  release("");
  assert.match(await again, /못 알아들었어요/);
});

test("정류소정보로 경로선 주변 정류장의 실제 좌표 (같은 이름 반대편은 경로선 가까운 쪽), 어림 위치는 정확한 위치로 바뀜", async () => {
  const { createServer } = await import("node:http");
  const { seoulStopsAlong, resetBusQuota } = await import("./realtime.js");
  const { StopCache } = await import("./stopcache.js");
  const { kakaoStopLocator } = await import("./transit.js");
  resetBusQuota();
  let hits = 0;
  const srv = createServer((_req, res) => {
    hits++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ msgBody: { itemList: [
      { stationNm: "황학동주민센터", gpsX: "127.0201", gpsY: "37.57045" }, // 경로선 바로 옆
      { stationNm: "황학동주민센터", gpsX: "127.0199", gpsY: "37.5712" }, // 길 건너 반대편 (약 90m)
      { stationNm: "다른정류장", gpsX: "127.0", gpsY: "37.57" },
    ] } }));
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const along = seoulStopsAlong("k", `http://127.0.0.1:${(srv.address() as { port: number }).port}`);
  const line: [number, number][] = [[127.014, 37.5704], [127.026, 37.5704]]; // 약 1km
  const out = await along({ stops: ["A", "황학동주민센터", "B"] }, line);
  assert.deepEqual(out, [null, { lon: 127.0201, lat: 37.57045 }, null]);
  assert.ok(hits >= 2 && hits <= 4, `호출 ${hits}`);
  // 어림 위치로 기억해 둔 것이 있어도 정확한 위치로 바꾼다
  const cache = new StopCache(null);
  cache.set(StopCache.key("bus", "241", "황학동주민센터"), [127.02, 37.57], true);
  const found = await kakaoStopLocator("k", () => {}, undefined, cache, along)({ kind: "bus", stops: ["A", "황학동주민센터", "B"], lines: ["241"] }, line);
  assert.deepEqual(found[1], { lon: 127.0201, lat: 37.57045 });
  assert.equal(cache.isApprox(StopCache.key("bus", "241", "황학동주민센터")), false);
  srv.close();
});
