// 카카오 로컬(키워드 검색) + 도보 경로 API.
// 파라미터 형식은 2026-11-04 직접 호출로 확인했다 (도보: start_x/start_y/end_x/end_y).

import { fetch } from "undici";
import { dispatcher } from "./proxy.js";
import { faultOn, withRetry } from "./faults.js";

// 테스트에서 가짜 서버로 바꿀 수 있게
const BASE = process.env.KAKAO_BASE ?? "https://dapi.kakao.com";

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

/** 카카오 호출. 타임아웃·연결 실패·5xx 는 0.5초 뒤 한 번 더 (400대는 바로 실패) */
async function getJson(url: URL, key: string): Promise<unknown> {
  if (faultOn("kakao")) throw new KakaoError("카카오 API 응답 없음 (오류 주입)");
  const once = async () => {
    const res = await fetch(url, { headers: authHeader(key), signal: AbortSignal.timeout(8000), dispatcher });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const b = body as { message?: string; msg?: string; code?: number; errorType?: string } | null;
      const msg = b?.message ?? b?.msg ?? res.statusText;
      // 사용량 초과: 429 또는 code -10 ("API limit has been exceeded"). 다시 시도해도 소용없으니 알아볼 수 있는 문구로
      if (res.status === 429 || b?.code === -10 || /limit|quota|throttl/i.test(`${msg} ${b?.errorType ?? ""}`)) {
        throw new KakaoError("카카오 사용량 초과 (오늘 한도 또는 잠시 너무 많이 호출함). 잠시 뒤 다시 해 주세요");
      }
      throw new KakaoError(`카카오 API ${res.status}: ${msg}`);
    }
    return body;
  };
  try {
    return await withRetry(once);
  } catch (e) {
    if (e instanceof KakaoError) throw e;
    throw new KakaoError(`카카오 API 응답 없음 (${e instanceof Error ? e.message : String(e)})`);
  }
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

/** 검색 후보. distance 는 기준 위치에서 m (기준이 없으면 null) */
export interface PlaceCandidate extends Place {
  distance: number | null;
}

/** 이 거리 안의 후보는 같은 곳으로 본다 (역 출구·호선, 같은 건물) */
const SAME_PLACE_M = 150;
const MAX_CANDIDATES = 5;

const norm = (t: string) => t.replace(/\s+/g, "").toLowerCase();

/**
 * 목적지 후보.
 * 기준 위치(near)가 있으면 가까운 순(20km 안)으로 찾고, 이름이 검색어로 시작하는 곳만 남긴다
 * (예: "맥도날드" → 맥도날드 외대점·전농점…). 150m 안에 붙은 것은 하나로 친다.
 * 그런 곳이 없으면 카카오 정확도 1등 하나 (예: "강남역" → 강남역 2호선. 가까운 순이면 "강남교자 뚝섬역점" 같은 것이 먼저 나온다).
 * 2026-11-04 회기역 기준으로 실제 호출해 확인한 동작에 맞춘 규칙.
 */
export function pickCandidates(query: string, nearby: PlaceCandidate[]): PlaceCandidate[] {
  const q = norm(query);
  const prefixed = nearby.filter((c) => norm(c.name).startsWith(q));
  // 검색어 뒤가 띄어쓰기로 끊기는 이름("왕십리역 2호선", "맥도날드 외대점")이 있으면 그것만.
  // "왕십리역요진와이하우스오피스텔", "경희대학교병원 소화기센터" 처럼 검색어가 더 긴 단어의 앞부분일 뿐인 곳은 뺀다
  const word = query.trim().replace(/\s+/g, " ");
  const bounded = prefixed.filter((c) => {
    const n = c.name.trim().replace(/\s+/g, " ");
    return n === word || n.startsWith(word + " ");
  });
  const out: PlaceCandidate[] = [];
  for (const c of bounded.length ? bounded : prefixed) {
    const dup = out.some((o) => {
      const dy = (o.y - c.y) * 110_540;
      const dx = (o.x - c.x) * 111_320 * Math.cos((o.y * Math.PI) / 180);
      return Math.hypot(dx, dy) < SAME_PLACE_M;
    });
    if (!dup) out.push(c);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

type RawDoc = { place_name: string; road_address_name?: string; address_name?: string; x: string; y: string; distance?: string };
const toCandidate = (d: RawDoc): PlaceCandidate => ({
  name: d.place_name,
  address: d.road_address_name || d.address_name || "",
  x: Number(d.x),
  y: Number(d.y),
  distance: d.distance ? Number(d.distance) : null,
});

export async function searchPlaces(query: string, key: string, near?: { lon: number; lat: number }): Promise<PlaceCandidate[]> {
  const search = async (sort: "distance" | "accuracy", size: number) => {
    const url = new URL("/v2/local/search/keyword.json", BASE);
    url.searchParams.set("query", query);
    url.searchParams.set("size", String(size));
    url.searchParams.set("sort", sort);
    if (near) {
      url.searchParams.set("x", String(near.lon));
      url.searchParams.set("y", String(near.lat));
      if (sort === "distance") url.searchParams.set("radius", "20000");
    }
    const body = (await getJson(url, key)) as { documents?: RawDoc[] };
    return (body.documents ?? []).map(toCandidate);
  };
  if (!near) return (await search("accuracy", 1)).slice(0, 1);
  const [nearby, [top]] = await Promise.all([search("distance", 15), search("accuracy", 1)]);
  // 정확도 1등도 20km 안이면 후보에 끼워 넣는다 (예: 경희대학교병원 옆에서 "경희대학교" → 병원 시설 + 서울캠퍼스)
  const pool = top && top.distance !== null && top.distance <= 20_000 ? [...nearby, top].sort((x, y) => (x.distance ?? 0) - (y.distance ?? 0)) : nearby;
  const picked = pickCandidates(query, pool);
  // 지점(…점)이 아닌 곳(역·학교 등)이면 카카오 정확도 1등을 맨 위로: "회기역" → 회기역 1호선이 공영주차장보다 먼저
  const i = top ? picked.findIndex((c) => c.name === top.name) : -1;
  if (i > 0 && !picked.some((c) => /점$/.test(c.name.trim()))) picked.unshift(...picked.splice(i, 1));
  if (picked.length) return picked;
  return top ? [top] : [];
}

/** 카테고리(예: SW8 지하철역) 가까운 순 */
export async function searchCategory(code: string, lon: number, lat: number, radius: number, key: string): Promise<PlaceCandidate[]> {
  const url = new URL("/v2/local/search/category.json", BASE);
  url.searchParams.set("category_group_code", code);
  url.searchParams.set("x", String(lon));
  url.searchParams.set("y", String(lat));
  url.searchParams.set("radius", String(radius));
  url.searchParams.set("sort", "distance");
  const body = (await getJson(url, key)) as { documents?: RawDoc[] };
  return (body.documents ?? []).map(toCandidate);
}

/** 주소(도로명·지번)로 좌표. 없으면 null */
export async function searchAddress(query: string, key: string): Promise<Place | null> {
  const url = new URL("/v2/local/search/address.json", BASE);
  url.searchParams.set("query", query);
  url.searchParams.set("size", "1");
  const body = (await getJson(url, key)) as {
    documents?: { address_name: string; road_address?: { address_name: string; building_name?: string } | null; x: string; y: string }[];
  };
  const d = body.documents?.[0];
  if (!d) return null;
  const addr = d.road_address?.address_name || d.address_name;
  return { name: d.road_address?.building_name || addr, address: addr, x: Number(d.x), y: Number(d.y) };
}

/** 좌표 → 주소 문자열 (도로명 우선). 못 찾으면 null */
export async function addressAt(lon: number, lat: number, key: string): Promise<string | null> {
  const url = new URL("/v2/local/geo/coord2address.json", BASE);
  url.searchParams.set("x", String(lon));
  url.searchParams.set("y", String(lat));
  const body = (await getJson(url, key)) as { documents?: { address?: { address_name: string } | null; road_address?: { address_name: string } | null }[] };
  const d = body.documents?.[0];
  return d?.road_address?.address_name || d?.address?.address_name || null;
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
