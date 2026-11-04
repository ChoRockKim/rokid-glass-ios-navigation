// 안경에 선택지를 띄우고 고른 번호를 기다린다 (목적지 후보가 여럿일 때).
// 폰 단축어 요청은 그동안 응답을 미뤘다가, 고르면 평소처럼 응답한다 → 단축어는 바꿀 필요 없음.
// 선택지를 띄울 수 있는 화면(안경 APK 0.3.4+, WebSocket ?choose=1)이 없거나 시간이 지나면 null → 호출한 쪽이 기본값(가장 가까운 곳)을 쓴다.

export type ChooseMessage =
  | { type: "choose"; id: number; title: string; items: string[]; timeoutSec: number }
  | { type: "choose-done"; id: number };

export const CHOOSE_TIMEOUT_MS = 40_000;

export class Chooser {
  private screens = new Set<(m: ChooseMessage) => void>();
  private pending: { id: number; resolve: (i: number | null) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private seq = 0;

  constructor(private timeoutMs = CHOOSE_TIMEOUT_MS) {}

  /** 선택지를 띄울 수 있는 화면 등록. 해제 함수를 돌려준다 */
  attach(send: (m: ChooseMessage) => void): () => void {
    this.screens.add(send);
    return () => this.screens.delete(send);
  }

  get available() {
    return this.screens.size > 0;
  }

  /** 고른 번호(0부터), 취소면 -1, 화면이 없거나 시간이 지나면 null */
  ask(title: string, items: string[]): Promise<number | null> {
    if (!this.available || items.length === 0) return Promise.resolve(null);
    this.finish(null); // 이전 질문은 기본값으로 끝낸다
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(null), this.timeoutMs);
      this.pending = { id, resolve, timer };
      for (const send of this.screens) send({ type: "choose", id, title, items, timeoutSec: Math.round(this.timeoutMs / 1000) });
    });
  }

  /** 안경이 보낸 답. index -1 = 취소 */
  answer(id: number, index: number) {
    if (this.pending?.id !== id) return;
    this.finish(Number.isInteger(index) && index >= -1 ? index : null);
  }

  private finish(result: number | null) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    for (const send of this.screens) send({ type: "choose-done", id: p.id });
    p.resolve(result);
  }
}
