// 미니맵 배경용 주변 도로 (OpenStreetMap, Overpass API). 데이터 © OpenStreetMap contributors (ODbL).
// 내 위치 반경 RADIUS_M 안의 도로 선만 가져온다. 위치가 REFETCH_M 이상 움직였을 때만 다시 가져온다.
// 실패해도 경로 미니맵은 그대로 나온다. (개발 세션에서는 두 출처 모두 접속 불가라 Railway 로그로 확인)
import { fetch } from "undici";
import { dispatcher } from "./proxy.js";
import { faultOn } from "./faults.js";
import { distanceM } from "./guide.js";
import type { MapMessage, Navigator, RoadKind } from "./navigation.js";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

// 1순위: OpenFreeMap 벡터 타일 (OpenMapTiles 스키마, CDN 정적 파일, 키 없음). transportation 레이어만 쓴다.
// 2순위: Overpass (공개 서버가 자주 502/504 — 2026-11-04 Railway 에서 세 곳 모두 실패 확인)
const TILEJSON = process.env.OFM_TILEJSON ?? "https://tiles.openfreemap.org/planet";
const TILE_Z = 14; // OpenMapTiles 최대 줌
const OMT_MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);
const UA = "rokid-route-server/0.1 (personal walking navigation prototype)";

function tileXY(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [x, y];
}

/** 벡터 타일(pbf)에서 도로 선만 뽑는다. bbox 밖 선은 버린다 */
/** OpenMapTiles transportation class → 그리기 종류 */
export function omtKind(cls: string): RoadKind | null {
  if (["motorway", "trunk", "primary", "secondary"].includes(cls)) return "major";
  if (["tertiary", "minor", "busway", "unclassified", "residential"].includes(cls)) return "road";
  if (["service", "track", "raceway"].includes(cls)) return "service";
  if (cls === "path") return "path"; // 보행로·자전거길·계단·광장 (subclass 로 구분됨)
  if (["rail", "transit"].includes(cls)) return "rail";
  return null; // ferry 등
}

type TileRoads = { lines: [number, number][][]; major: boolean[]; kinds: RoadKind[]; buildings: [number, number][][] };

/** 벡터 타일(pbf)에서 도로(종류별)와 건물 윤곽을 뽑는다. bbox 밖은 버린다. 터널(지하철 등)은 뺀다 */
export function roadsFromTile(buf: Uint8Array, x: number, y: number, z: number, bbox: [number, number, number, number]): TileRoads {
  const tile = new VectorTile(new PbfReader(buf));
  const out: TileRoads = { lines: [], major: [], kinds: [], buildings: [] };
  const [w, s, e, n] = bbox;
  const inBox = (ring: [number, number][]) => ring.some(([lo, la]) => lo >= w && lo <= e && la >= s && la <= n);
  const q = (ring: [number, number][]) => ring.map(([lo, la]) => [Math.round(lo * 1e6) / 1e6, Math.round(la * 1e6) / 1e6] as [number, number]);

  const tr = tile.layers["transportation"];
  for (let i = 0; tr && i < tr.length; i++) {
    const f = tr.feature(i);
    if (f.type !== 2) continue; // LineString
    if (f.properties["brunnel"] === "tunnel") continue;
    const kind = omtKind(String(f.properties["class"] ?? ""));
    if (!kind) continue;
    const gj = f.toGeoJSON(x, y, z) as { geometry: { type: string; coordinates: unknown } };
    const parts = (gj.geometry.type === "MultiLineString" ? gj.geometry.coordinates : [gj.geometry.coordinates]) as [number, number][][];
    for (const part of parts) {
      if (!inBox(part)) continue;
      out.lines.push(q(part));
      out.kinds.push(kind);
      out.major.push(kind === "major");
    }
  }

  const bl = tile.layers["building"];
  for (let i = 0; bl && i < bl.length; i++) {
    const f = bl.feature(i);
    if (f.type !== 3) continue; // Polygon
    const gj = f.toGeoJSON(x, y, z) as { geometry: { type: string; coordinates: unknown } };
    const polys = (gj.geometry.type === "MultiPolygon" ? gj.geometry.coordinates : [gj.geometry.coordinates]) as [number, number][][][];
    for (const poly of polys) {
      const outer = poly[0];
      if (!outer || outer.length < 3 || !inBox(outer)) continue;
      const box = simplifyBuilding(outer);
      if (box) out.buildings.push(q(box));
    }
  }
  return out;
}

/** 이보다 작은 건물(창고·부속 건물 등)은 버린다 */
const MIN_BUILDING_M2 = 60;
/** 한 번에 보내는 건물 수 상한 (내 위치에서 가까운 순) */
const MAX_BUILDINGS = 150;

/**
 * 건물 윤곽을 그 건물을 감싸는 가장 작은 (회전된) 직사각형 4점으로 바꾼다.
 * 안경에서는 건물 모양보다 "여기 건물이 있다" 정도만 보이면 되고, 도로가 주인공이다.
 * 면적이 MIN_BUILDING_M2 미만이면 null.
 */
export function simplifyBuilding(ring: [number, number][]): [number, number][] | null {
  const lat0 = ring[0]![1];
  const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180), my = 110_540;
  const lon0 = ring[0]![0];
  const pts = ring.map(([lo, la]) => [(lo - lon0) * mx, (la - lat0) * my] as [number, number]);
  // 넓이 (신발끈 공식)
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!, [x2, y2] = pts[(i + 1) % pts.length]!;
    area += x1 * y2 - x2 * y1;
  }
  if (Math.abs(area) / 2 < MIN_BUILDING_M2) return null;
  // 볼록 껍질의 각 변 방향으로 돌려 본 바운딩 박스 중 가장 작은 것
  const hull = convexHull(pts);
  let best: { a: number; c: number; s: number; x0: number; x1: number; y0: number; y1: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i]!, [bx, by] = hull[(i + 1) % hull.length]!;
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-9) continue;
    const c = (bx - ax) / len, s = (by - ay) / len;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of hull) {
      const u = x * c + y * s, v = -x * s + y * c;
      x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
    }
    const a = (x1 - x0) * (y1 - y0);
    if (!best || a < best.a) best = { a, c, s, x0, x1, y0, y1 };
  }
  if (!best) return null;
  const { c, s, x0, x1, y0, y1 } = best;
  const back = (u: number, v: number): [number, number] => [lon0 + (u * c - v * s) / mx, lat0 + (u * s + v * c) / my];
  return [back(x0, y0), back(x1, y0), back(x1, y1), back(x0, y1)];
}

function convexHull(p: [number, number][]): [number, number][] {
  const pts = [...p].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop(); lower.push(q); }
  for (const q of pts.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** 내 위치에서 가까운 건물 MAX_BUILDINGS 개만 */
export function nearestBuildings(b: [number, number][][], lon: number, lat: number, max = MAX_BUILDINGS): [number, number][][] {
  if (b.length <= max) return b;
  const k = Math.cos((lat * Math.PI) / 180);
  const d = (r: [number, number][]) => { const [x, y] = r[0]!; return ((x - lon) * k) ** 2 + (y - lat) ** 2; };
  return b.map((r) => [d(r), r] as const).sort((a, z) => a[0] - z[0]).slice(0, max).map((e) => e[1]);
}

// 공개 Overpass 인스턴스. 앞에서부터 시도하고, 성공한 곳을 다음에 먼저 쓴다.
// (2026-11-04 Railway 에서 overpass-api.de 가 "fetch failed" — 원인 확인 중이라 예비를 둔다)
const ENDPOINTS = (process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

/** undici 의 "fetch failed" 밑에 숨은 실제 원인 */
function why(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const c = (e as Error & { cause?: { code?: string; message?: string } }).cause;
  return c ? `${e.message} (${c.code ?? ""} ${c.message ?? ""})`.trim() : e.message;
}
const RADIUS_M = 250;
const REFETCH_M = 120;
/** Overpass(공개 서버)만 간격 제한. 타일은 CDN 이라 제한 없이 바로 */
const OVERPASS_MIN_INTERVAL_MS = 15_000;
/** 연달아 위치가 바뀌면(탭으로 빠르게 넘김) 마지막 위치만 조회 */
const DEBOUNCE_MS = 300;
const TILE_CACHE = 40;

const MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);
const KINDS =
  "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|footway|path|steps|service|cycleway";

type Roads = Extract<MapMessage, { type: "map-roads" }>;

export function parseOverpass(body: unknown): Roads {
  const els = ((body as { elements?: unknown[] })?.elements ?? []) as {
    type?: string;
    tags?: Record<string, string>;
    geometry?: { lat: number; lon: number }[];
  }[];
  const lines: [number, number][][] = [];
  const major: boolean[] = [];
  const kinds: RoadKind[] = [];
  for (const e of els) {
    if (e.type !== "way" || !e.geometry || e.geometry.length < 2) continue;
    const hw = e.tags?.highway ?? "";
    const kind: RoadKind = MAJOR.has(hw) && hw !== "tertiary" ? "major" : ["footway", "path", "steps", "pedestrian", "cycleway"].includes(hw) ? "path" : hw === "service" ? "service" : "road";
    lines.push(e.geometry.map((g) => [Math.round(g.lon * 1e6) / 1e6, Math.round(g.lat * 1e6) / 1e6]));
    kinds.push(kind);
    major.push(kind === "major");
  }
  return { type: "map-roads", lines, major, kinds, buildings: [] };
}

export class RoadFeed {
  private center: [number, number] | null = null;
  private lastOverpass = 0;
  private busy = false;
  private pending: [number, number] | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 받은 타일 원본 (키 "x/y"). 지나간 곳으로 돌아가면 다시 받지 않는다 */
  private tiles = new Map<string, Uint8Array>();
  private latest: Roads | null = null;
  private listeners = new Set<(m: Roads) => void>();

  constructor(
    nav: Navigator,
    private log: (m: string) => void,
  ) {
    nav.onMap((m) => {
      if (m.type === "map-pos") this.schedule(m.lon, m.lat);
      if (m.type === "map-route") this.center = null; // 새 경로면 다시 가져온다
    });
  }

  onRoads(fn: (m: Roads) => void) {
    this.listeners.add(fn);
  }

  snapshot(): Roads | null {
    return this.latest;
  }

  private preferred = 0;
  private tileTemplate: string | null = null;

  private async getBytes(url: string): Promise<Uint8Array> {
    if (faultOn("tiles")) throw new Error("오류 주입: tiles");
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10_000), dispatcher });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** 내 위치 ±RADIUS 상자를 덮는 z14 타일(보통 1장, 경계면 2~4장)에서 도로를 모은다 */
  private async fromTiles(lon: number, lat: number): Promise<Roads> {
    if (!this.tileTemplate) {
      const tj = JSON.parse(new TextDecoder().decode(await this.getBytes(TILEJSON))) as { tiles?: string[] };
      if (!tj.tiles?.[0]) throw new Error("tilejson 에 tiles 없음");
      this.tileTemplate = tj.tiles[0];
    }
    const dLat = RADIUS_M / 110_540;
    const dLon = RADIUS_M / (111_320 * Math.cos((lat * Math.PI) / 180));
    const bbox: [number, number, number, number] = [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
    const [x0, y0] = tileXY(bbox[0], bbox[3], TILE_Z);
    const [x1, y1] = tileXY(bbox[2], bbox[1], TILE_Z);
    const out: Roads = { type: "map-roads", lines: [], major: [], kinds: [], buildings: [] };
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const r = roadsFromTile(await this.tile(x, y), x, y, TILE_Z, bbox);
        out.lines.push(...r.lines);
        out.major.push(...r.major);
        out.kinds.push(...r.kinds);
        out.buildings.push(...r.buildings);
      }
    }
    out.buildings = nearestBuildings(out.buildings, lon, lat);
    return out;
  }

  private async tile(x: number, y: number): Promise<Uint8Array> {
    const key = `${x}/${y}`;
    const hit = this.tiles.get(key);
    if (hit) {
      this.tiles.delete(key);
      this.tiles.set(key, hit); // 최근 사용으로
      return hit;
    }
    const url = this.tileTemplate!.replace("{z}", String(TILE_Z)).replace("{x}", String(x)).replace("{y}", String(y));
    const buf = await this.getBytes(url);
    this.tiles.set(key, buf);
    if (this.tiles.size > TILE_CACHE) this.tiles.delete(this.tiles.keys().next().value!);
    return buf;
  }

  private async query(q: string): Promise<unknown> {
    const errors: string[] = [];
    for (let k = 0; k < ENDPOINTS.length; k++) {
      const i = (this.preferred + k) % ENDPOINTS.length;
      const url = ENDPOINTS[i]!;
      try {
        const res = await fetch(url, {
          method: "POST",
          body: new URLSearchParams({ data: q }),
          headers: { "user-agent": "rokid-route-server/0.1 (personal walking navigation prototype)" },
          signal: AbortSignal.timeout(15_000),
          dispatcher,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        this.preferred = i;
        return body;
      } catch (e) {
        errors.push(`${new URL(url).host}: ${why(e)}`);
      }
    }
    throw new Error(errors.join(" | "));
  }

  private schedule(lon: number, lat: number) {
    this.pending = [lon, lat];
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), DEBOUNCE_MS);
  }

  private async run() {
    this.timer = null;
    if (this.busy || !this.pending) return; // 끝나면 finally 에서 다시 본다
    const [lon, lat] = this.pending;
    this.pending = null;
    if (this.center && distanceM(this.center, [lon, lat]) < REFETCH_M) return;
    this.busy = true;
    try {
      let roads: Roads;
      let via = "openfreemap";
      try {
        roads = await this.fromTiles(lon, lat);
      } catch (e) {
        this.tileTemplate = null;
        if (Date.now() - this.lastOverpass < OVERPASS_MIN_INTERVAL_MS) throw e;
        this.lastOverpass = Date.now();
        this.log(`roads 타일 실패, Overpass 로: ${why(e)}`);
        const q = `[out:json][timeout:20];way(around:${RADIUS_M},${lat.toFixed(6)},${lon.toFixed(6)})[highway~"^(${KINDS})$"];out geom;`;
        roads = parseOverpass(await this.query(q));
        via = new URL(ENDPOINTS[this.preferred]!).host;
      }
      this.center = [lon, lat];
      this.latest = roads;
      this.log(`roads: ${roads.lines.length} lines, ${roads.buildings.length} buildings around ${lat.toFixed(4)},${lon.toFixed(4)} via ${via} (tiles cached ${this.tiles.size})`);
      for (const fn of this.listeners) fn(roads);
    } catch (e) {
      this.log(`roads 실패: ${why(e)}`);
    } finally {
      this.busy = false;
      if (this.pending) void this.run(); // 조회하는 동안 들어온 최신 위치
    }
  }
}
