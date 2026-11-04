import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

/** `Authorization: Bearer x` 우선, 헤더를 못 넣는 클라이언트는 `?token=x` */
export function tokenFrom(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
