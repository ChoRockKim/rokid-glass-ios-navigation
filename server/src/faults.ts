// 오류 주입 (테스트·실험용). FAULTS 환경 변수에 쉼표로: kakao, realtime, tiles
// 예: FAULTS=realtime → 서울 실시간 API 를 부르지 않고 바로 실패. 운영에서는 비워 둔다.
export type FaultKind = "kakao" | "realtime" | "tiles";

export function faultOn(kind: FaultKind): boolean {
  return (process.env.FAULTS ?? "").split(",").map((s) => s.trim()).includes(kind);
}

export class InjectedFault extends Error {
  constructor(kind: FaultKind) {
    super(`오류 주입: ${kind}`);
  }
}

/** 한 번 다시 해 볼 만한 실패인가: 타임아웃·연결 실패·5xx */
export function retryable(e: unknown): boolean {
  if (e instanceof InjectedFault) return false;
  const m = e instanceof Error ? `${e.name} ${e.message} ${(e as { cause?: { code?: string } }).cause?.code ?? ""}` : String(e);
  return /Timeout|AbortError|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR| 5\d\d[:\s]/.test(m);
}

/** fn 이 일시적인 이유로 실패하면 waitMs 뒤 한 번 더 */
export async function withRetry<T>(fn: () => Promise<T>, waitMs = 500): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!retryable(e)) throw e;
    await new Promise((r) => setTimeout(r, waitMs));
    return fn();
  }
}
