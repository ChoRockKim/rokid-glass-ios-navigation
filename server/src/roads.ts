// 미니맵 배경용 주변 도로 (OpenStreetMap, Overpass API). 데이터 © OpenStreetMap contributors (ODbL).
// 내 위치 반경 RADIUS_M 안의 도로 선만 가져온다. 위치가 REFETCH_M 이상 움직였을 때만 다시 가져온다.
// ⚠ 클라우드 개발 세션에서는 overpass-api.de 연결이 끊겨 직접 확인하지 못했다. 실패해도 경로 미니맵은 그대로 나온다.
import { fetch } from "undici";
import { dispatcher } from "./proxy.js";
import { distanceM } from "./guide.js";
import type { MapMessage, Navigator } from "./navigation.js";

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

  private preferred = 0;

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

  private async maybeFetch(lon: number, lat: number) {
    if (this.busy) return;
    if (this.center && distanceM(this.center, [lon, lat]) < REFETCH_M) return;
    if (Date.now() - this.lastTry < MIN_INTERVAL_MS) return;
    this.busy = true;
    this.lastTry = Date.now();
    const q = `[out:json][timeout:10];way(around:${RADIUS_M},${lat.toFixed(6)},${lon.toFixed(6)})[highway~"^(${KINDS})$"];out geom;`;
    try {
      const roads = parseOverpass(await this.query(q));
      this.center = [lon, lat];
      this.latest = roads;
      this.log(`roads: ${roads.lines.length} ways around ${lat.toFixed(4)},${lon.toFixed(4)} via ${new URL(ENDPOINTS[this.preferred]!).host}`);
      for (const fn of this.listeners) fn(roads);
    } catch (e) {
      this.log(`roads 실패: ${why(e)}`);
    } finally {
      this.busy = false;
    }
  }
}
