// 카카오 로컬(키워드 검색) + 도보 경로 API.
// 파라미터 형식은 2026-11-04 직접 호출로 확인했다 (도보: start_x/start_y/end_x/end_y).

import { fetch } from "undici";
import { dispatcher } from "./proxy.js";

const BASE = "https://dapi.kakao.com";

export interface Place {
  name: string;
  address: string;
  x: number; // 경도
  y: number; // 위도
}

export type LonLat = [number, number];

export interface Step {
  guidance: string;
  distance: number; // m
  time: number; // s
  x: number;
  y: number;
  points: LonLat[]; // 이 단계의 경로 좌표 (경도, 위도)
}

export interface WalkRoute {
  totalDistance: number;
  totalTime: number;
  landingUrl?: string;
  steps: Step[];
}

export class KakaoError extends Error {}

function authHeader(key: string) {
  return { Authorization: `KakaoAK ${key}` };
}

async function getJson(url: URL, key: string): Promise<unknown> {
  const res = await fetch(url, { headers: authHeader(key), signal: AbortSignal.timeout(8000), dispatcher });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { message?: string } | null)?.message ?? res.statusText;
    throw new KakaoError(`카카오 API ${res.status}: ${msg}`);
  }
  return body;
}

export async function searchPlace(query: string, key: string): Promise<Place | null> {
  const url = new URL("/v2/local/search/keyword.json", BASE);
  url.searchParams.set("query", query);
  url.searchParams.set("size", "1");
  const body = (await getJson(url, key)) as {
    documents?: { place_name: string; road_address_name?: string; address_name?: string; x: string; y: string }[];
  };
  const d = body.documents?.[0];
  if (!d) return null;
  return {
    name: d.place_name,
    address: d.road_address_name || d.address_name || "",
    x: Number(d.x),
    y: Number(d.y),
  };
}

interface RawWalk {
  status?: string;
  route?: {
    properties?: { totalDistance?: number; totalTime?: number; landingUrl?: string };
    legs?: { steps?: { properties: Omit<Step, "points">; path?: { points?: LonLat[] } }[] }[];
  };
}

export function parseWalk(body: RawWalk): WalkRoute {
  const route = body.route;
  if (!route?.legs?.length) throw new KakaoError(`도보 경로 없음 (status=${body.status ?? "?"})`);
  const steps = route.legs.flatMap((l) => l.steps ?? []).map(({ properties: p, path }) => ({
    guidance: p.guidance,
    distance: p.distance,
    time: p.time,
    x: p.x,
    y: p.y,
    points: path?.points?.length ? path.points : [[p.x, p.y] as LonLat],
  }));
  return {
    totalDistance: route.properties?.totalDistance ?? steps.reduce((a, s) => a + s.distance, 0),
    totalTime: route.properties?.totalTime ?? steps.reduce((a, s) => a + s.time, 0),
    landingUrl: route.properties?.landingUrl,
    steps,
  };
}

// ── 대중교통 ── (2026-11-04 직접 호출로 형식 확인. 실시간 도착·정류장 ID 는 없다)
export type TransitKind = "WALKING" | "BUS" | "SUBWAY";

export interface TransitLeg {
  kind: TransitKind;
  guidance: string; // 예: "간선 421 (제기역약령시장 > 성동구청)"
  distance: number;
  time: number; // s
  stops: string[]; // 탑승 ~ 하차 정류장 이름 전부 (WALKING 은 [출발, 도착])
  lines: string[]; // 탈 수 있는 노선 이름 (예: ["421"], ["1호선"])
  points: LonLat[];
}

export interface TransitRoute {
  type: string; // SUBWAY | BUS | BUS_AND_SUBWAY
  totalDistance: number;
  totalTime: number;
  transfers: number;
  fare: number | null;
  legs: TransitLeg[];
}

export async function transitRoutes(from: Place, to: Place, key: string): Promise<{ routes: TransitRoute[]; landingUrl?: string }> {
  const url = new URL("/v2/routing/publictraffic", BASE);
  url.searchParams.set("start_x", String(from.x));
  url.searchParams.set("start_y", String(from.y));
  url.searchParams.set("end_x", String(to.x));
  url.searchParams.set("end_y", String(to.y));
  return parseTransit((await getJson(url, key)) as RawTransit);
}

interface RawTransit {
  status?: string;
  properties?: { landingURL?: string };
  routes?: {
    properties: { type: string; totalDistance: number; totalTime: number; transfers?: number; fare?: { value?: number } };
    steps?: {
      properties: { type: string; guidance: string; distance: number; time: number; stops?: { name: string }[]; vehicles?: { name: string }[] };
      path?: { points?: LonLat[] };
    }[];
  }[];
}

export function parseTransit(body: RawTransit): { routes: TransitRoute[]; landingUrl?: string } {
  if (!body.routes?.length) throw new KakaoError(`대중교통 경로 없음 (status=${body.status ?? "?"})`);
  return {
    landingUrl: body.properties?.landingURL,
    routes: body.routes.map((r) => ({
      type: r.properties.type,
      totalDistance: r.properties.totalDistance,
      totalTime: r.properties.totalTime,
      transfers: r.properties.transfers ?? 0,
      fare: r.properties.fare?.value ?? null,
      legs: (r.steps ?? []).map(({ properties: p, path }) => ({
        kind: (["BUS", "SUBWAY"].includes(p.type) ? p.type : "WALKING") as TransitKind,
        guidance: p.guidance,
        distance: p.distance,
        time: p.time,
        stops: (p.stops ?? []).map((s) => s.name),
        lines: [...new Set((p.vehicles ?? []).map((v) => v.name))],
        points: path?.points ?? [],
      })),
    })),
  };
}

export async function walkRoute(from: Place, to: Place, key: string): Promise<WalkRoute> {
  const url = new URL("/v2/routing/walk", BASE);
  url.searchParams.set("start_x", String(from.x));
  url.searchParams.set("start_y", String(from.y));
  url.searchParams.set("end_x", String(to.x));
  url.searchParams.set("end_y", String(to.y));
  return parseWalk((await getJson(url, key)) as RawWalk);
}
