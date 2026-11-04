// 장소 이름 또는 좌표 → 카카오 도보 경로. Slack 과 HTTP API 가 같이 쓴다.
import { searchPlaces, walkRoute, KakaoError, type Place, type PlaceCandidate, type WalkRoute } from "./kakao.js";

export type PlaceInput = string | { lon: number; lat: number; name?: string };

/** 후보가 여럿일 때 하나 고르기 (안경 선택지). 취소면 ChoiceCancelled 를 던진다 */
export type ChoosePlace = (query: string, candidates: PlaceCandidate[]) => Promise<PlaceCandidate>;

export class ChoiceCancelled extends Error {
  constructor() {
    super("목적지 선택을 취소했습니다");
  }
}

export interface ResolveOptions {
  /** 이 위치에서 가까운 곳을 찾는다 (같은 이름 지점이 여럿인 가게 등) */
  near?: { lon: number; lat: number };
  /** 없으면 가장 가까운 후보 */
  choose?: ChoosePlace;
}

export async function resolvePlace(input: PlaceInput, key: string, opts: ResolveOptions = {}): Promise<Place> {
  if (typeof input !== "string") {
    return { name: input.name ?? "현재 위치", address: "", x: input.lon, y: input.lat };
  }
  const found = await searchPlaces(input, key, opts.near);
  if (!found.length) throw new KakaoError(`장소를 찾지 못했습니다: ${input}`);
  const c = found.length > 1 && opts.choose ? await opts.choose(input, found) : found[0]!;
  return { name: c.name, address: c.address, x: c.x, y: c.y };
}

/** 출발지를 먼저 정하고, 목적지는 출발지 근처에서 찾는다 */
export async function resolvePair(from: PlaceInput, to: PlaceInput, key: string, choose?: ChoosePlace): Promise<[Place, Place]> {
  const f = await resolvePlace(from, key);
  const t = await resolvePlace(to, key, { near: { lon: f.x, lat: f.y }, choose });
  return [f, t];
}

export async function planRoute(
  from: PlaceInput,
  to: PlaceInput,
  key: string,
  choose?: ChoosePlace,
): Promise<{ from: Place; to: Place; route: WalkRoute }> {
  const [f, t] = await resolvePair(from, to, key, choose);
  const route = await walkRoute(f, t, key);
  return { from: f, to: t, route };
}
