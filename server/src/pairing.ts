// 안경 앱 페어링. APK 에 토큰을 넣지 않기 위해 쓴다.
//
// 1) 안경: POST /pair/request            → {id, code}      (인증 없음. 화면에 code 4자리 표시)
// 2) 폰:   POST /pair/approve {code}      (API_TOKEN 인증, 단축어 "안경 연결")
// 3) 안경: GET  /pair/status?id=…        → {status:"pending"} 또는 {status:"approved", token}
//    받은 token(GLASS_TOKEN)을 저장해 두고 /glass 에 붙는다.
//
// 코드는 5분 유효, 동시에 최대 MAX_PENDING 개. 승인된 요청은 토큰을 한 번만 내려준다.
import { randomInt, randomUUID } from "node:crypto";

const TTL_MS = 5 * 60_000;
const MAX_PENDING = 5;

interface PairRequest {
  id: string;
  code: string;
  createdAt: number;
  approved: boolean;
  delivered: boolean;
}

export class Pairing {
  private reqs = new Map<string, PairRequest>();

  constructor(
    private glassToken: string,
    private now: () => number = Date.now,
  ) {}

  private sweep() {
    const t = this.now();
    for (const [id, r] of this.reqs) if (t - r.createdAt > TTL_MS || r.delivered) this.reqs.delete(id);
  }

  request(): { id: string; code: string; expiresInSec: number } | null {
    this.sweep();
    if (this.reqs.size >= MAX_PENDING) return null;
    const used = new Set([...this.reqs.values()].map((r) => r.code));
    let code = "";
    do code = String(randomInt(1000, 10000));
    while (used.has(code));
    const r: PairRequest = { id: randomUUID(), code, createdAt: this.now(), approved: false, delivered: false };
    this.reqs.set(r.id, r);
    return { id: r.id, code, expiresInSec: TTL_MS / 1000 };
  }

  approve(code: string): boolean {
    this.sweep();
    for (const r of this.reqs.values()) {
      if (r.code === code.trim() && !r.approved) {
        r.approved = true;
        return true;
      }
    }
    return false;
  }

  status(id: string): { status: "pending" } | { status: "approved"; token: string } | { status: "expired" } {
    this.sweep();
    const r = this.reqs.get(id);
    if (!r) return { status: "expired" };
    if (!r.approved) return { status: "pending" };
    r.delivered = true;
    return { status: "approved", token: this.glassToken };
  }
}
