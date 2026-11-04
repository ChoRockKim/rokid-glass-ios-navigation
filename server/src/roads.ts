// 미니맵 배경용 주변 도로 (OpenStreetMap, Overpass API). 데이터 © OpenStreetMap contributors (ODbL).
// 내 위치 반경 RADIUS_M 안의 도로 선만 가져온다. 위치가 REFETCH_M 이상 움직였을 때만 다시 가져온다.
// ⚠ 클라우드 개발 세션에서는 overpass-api.de 연결이 끊겨 직접 확인하지 못했다. 실패해도 경로 미니맵은 그대로 나온다.
import { fetch } from "undici";
import { dispatcher } from "./proxy.js";
import { distanceM } from "./guide.js";
import type { MapMessage, Navigator } from "./navigation.js";

const ENDPOINT = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
const RADIUS_M = 250;
const REFETCH_M = 120;
const MIN_INTERVAL_MS = 15_000;

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
  for (const e of els) {
    if (e.type !== "way" || !e.geometry || e.geometry.length < 2) continue;
    lines.push(e.geometry.map((g) => [Math.round(g.lon * 1e6) / 1e6, Math.round(g.lat * 1e6) / 1e6]));
    major.push(MAJOR.has(e.tags?.highway ?? ""));
  }
  return { type: "map-roads", lines, major };
}

export class RoadFeed {
  private center: [number, number] | null = null;
  private lastTry = 0;
  private busy = false;
  private latest: Roads | null = null;
  private listeners = new Set<(m: Roads) => void>();

  constructor(
    nav: Navigator,
    private log: (m: string) => void,
  ) {
    nav.onMap((m) => {
      if (m.type === "map-pos") void this.maybeFetch(m.lon, m.lat);
      if (m.type === "map-route") this.center = null; // 새 경로면 다시 가져온다
    });
  }

  onRoads(fn: (m: Roads) => void) {
    this.listeners.add(fn);
  }

  snapshot(): Roads | null {
    return this.latest;
  }

  private async maybeFetch(lon: number, lat: number) {
    if (this.busy) return;
    if (this.center && distanceM(this.center, [lon, lat]) < REFETCH_M) return;
    if (Date.now() - this.lastTry < MIN_INTERVAL_MS) return;
    this.busy = true;
    this.lastTry = Date.now();
    const q = `[out:json][timeout:10];way(around:${RADIUS_M},${lat.toFixed(6)},${lon.toFixed(6)})[highway~"^(${KINDS})$"];out geom;`;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        body: new URLSearchParams({ data: q }),
        headers: { "user-agent": "rokid-route-server/0.1 (personal walking navigation prototype)" },
        signal: AbortSignal.timeout(15_000),
        dispatcher,
      });
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      const roads = parseOverpass(await res.json());
      this.center = [lon, lat];
      this.latest = roads;
      this.log(`roads: ${roads.lines.length} ways around ${lat.toFixed(4)},${lon.toFixed(4)}`);
      for (const fn of this.listeners) fn(roads);
    } catch (e) {
      this.log(`roads 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.busy = false;
    }
  }
}
