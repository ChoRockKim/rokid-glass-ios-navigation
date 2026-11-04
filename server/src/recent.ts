// 최근 목적지: 길안내를 시작한 목적지 몇 곳을 기억한다 (안경 메뉴 → 목적지 → 최근). 안경엔 글자 입력이 없어서
// 한 번 갔던 곳을 폰 없이 다시 가는 방법. 볼륨의 JSON 파일 하나 (재시작해도 유지).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RecentPlace {
  /** 목적지 이름 (같은 이름은 하나로, 가장 최근 것) */
  name: string;
  address: string;
  x: number;
  y: number;
  at: string;
}

export const RECENT_MAX = 8;

export class Recent {
  private items: RecentPlace[] = [];

  constructor(private file: string | null) {
    if (file && existsSync(file)) {
      try {
        this.items = (JSON.parse(readFileSync(file, "utf8")) as { items?: RecentPlace[] }).items ?? [];
      } catch {
        this.items = [];
      }
    }
  }

  list(): RecentPlace[] {
    return [...this.items];
  }

  get(name: string): RecentPlace | undefined {
    return this.items.find((p) => p.name === name);
  }

  /** "현재 위치" 같은 출발지는 넣지 않는다 */
  add(p: { name: string; address: string; x: number; y: number }) {
    if (!p.name || p.name === "현재 위치") return;
    this.items = [{ ...p, at: new Date().toISOString() }, ...this.items.filter((x) => x.name !== p.name)].slice(0, RECENT_MAX);
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + ".tmp", JSON.stringify({ items: this.items }));
      renameSync(this.file + ".tmp", this.file);
    } catch {
      // 기록 실패는 길안내에 영향 없음
    }
  }
}
