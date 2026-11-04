// 즐겨찾기: 별명 + 주소(또는 장소 이름) + 카테고리. 볼륨의 JSON 파일 하나에 보관한다.
// 등록·삭제는 폰(/places 페이지, 단축어), 고르기는 안경 메뉴 (즐겨찾기 → 카테고리 → 장소 → 도보/대중교통).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Favorite {
  id: string;
  /** 별명 (예: 집, 회사, 단골 국밥) */
  name: string;
  /** 카테고리 (없으면 "기타") */
  category: string;
  /** 사용자가 넣은 주소·장소 이름 그대로 (또는 현재 위치의 주소) */
  address: string;
  /** 카카오가 찾은 이름 (확인용) */
  place: string;
  x: number;
  y: number;
  addedAt: string;
}

export const DEFAULT_CATEGORY = "기타";

export class Favorites {
  private items: Favorite[] = [];

  constructor(private file: string | null) {
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as { items?: Favorite[] };
        this.items = data.items ?? [];
      } catch {
        this.items = [];
      }
    }
  }

  list(): Favorite[] {
    return [...this.items];
  }

  get(id: string): Favorite | undefined {
    return this.items.find((f) => f.id === id);
  }

  /** 카테고리 목록 (처음 등록한 순서, "기타"는 맨 뒤) */
  categories(): string[] {
    const seen = [...new Set(this.items.map((f) => f.category))];
    return [...seen.filter((c) => c !== DEFAULT_CATEGORY), ...seen.filter((c) => c === DEFAULT_CATEGORY)];
  }

  /** 같은 별명이 있으면 바꾼다 */
  upsert(f: Omit<Favorite, "id" | "addedAt">): Favorite {
    const name = f.name.trim();
    const category = f.category.trim() || DEFAULT_CATEGORY;
    const old = this.items.find((x) => x.name === name);
    const next: Favorite = { ...f, name, category, id: old?.id ?? randomUUID().slice(0, 8), addedAt: new Date().toISOString() };
    this.items = old ? this.items.map((x) => (x === old ? next : x)) : [...this.items, next];
    this.save();
    return next;
  }

  /** 별명 또는 id 로 지운다 */
  remove(nameOrId: string): Favorite | null {
    const f = this.items.find((x) => x.name === nameOrId.trim() || x.id === nameOrId);
    if (!f) return null;
    this.items = this.items.filter((x) => x !== f);
    this.save();
    return f;
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify({ items: this.items }, null, 1));
    renameSync(this.file + ".tmp", this.file);
  }
}
