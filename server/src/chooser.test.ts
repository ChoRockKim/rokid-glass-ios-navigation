import { test } from "node:test";
import assert from "node:assert/strict";
import { Chooser, type ChooseMessage } from "./chooser.js";
import { pickCandidates, type PlaceCandidate } from "./kakao.js";

test("Chooser: 화면 없으면 바로 null, 고르면 번호, 시간 지나면 null", async () => {
  const c = new Chooser(50);
  assert.equal(await c.ask("t", ["a", "b"]), null);
  const got: ChooseMessage[] = [];
  const detach = c.attach((m) => got.push(m));
  const p = c.ask("목적지 선택 · 맥도날드", ["외대점", "전농점"]);
  const ask = got[0]!;
  assert.equal(ask.type, "choose");
  c.answer(ask.id + 99, 1); // 다른 질문의 답은 무시
  c.answer(ask.id, 1);
  assert.equal(await p, 1);
  assert.equal(got.at(-1)!.type, "choose-done");
  assert.equal(await c.ask("t", ["a"]), null); // 50ms 뒤 기본값
  const p2 = c.ask("t", ["a"]);
  c.answer((got.at(-1) as { id: number }).id, -1);
  assert.equal(await p2, -1);
  detach();
  assert.equal(c.available, false);
});

test("pickCandidates: 검색어로 시작하는 지점만 가까운 순, 150m 안은 하나로", () => {
  const at = (name: string, dx: number, distance: number): PlaceCandidate => ({ name, address: "", x: 127.06 + dx / 88_000, y: 37.59, distance });
  const nearby = [
    at("강남교자 뚝섬역점", 0, 100),
    at("맥도날드 외대점", 700, 770),
    at("맥도날드 외대점 주차장", 750, 800), // 50m → 같은 곳
    at("맥도날드 전농점", 1300, 1296),
    at("헤어 맥도날드", 1400, 1400),
  ];
  assert.deepEqual(pickCandidates("맥도날드", nearby).map((c) => c.name), ["맥도날드 외대점", "맥도날드 전농점"]);
  assert.deepEqual(pickCandidates("강남역", nearby), []); // → 정확도 1등으로
  assert.deepEqual(pickCandidates("맥 도날드", nearby).length, 2); // 띄어쓰기 무시
});

test("pickCandidates: 검색어 뒤가 띄어쓰기인 이름 우선", () => {
  const at = (name: string, dx: number): PlaceCandidate => ({ name, address: "", x: 127.03 + dx / 88_000, y: 37.56, distance: dx });
  const nearby = [at("왕십리역요진와이하우스오피스텔", 0), at("왕십리역 2호선", 400), at("왕십리역 5호선", 450), at("경희대학교병원 소화기센터", 900), at("경희대학교 서울캠퍼스", 1300)];
  assert.deepEqual(pickCandidates("왕십리역", nearby).map((c) => c.name), ["왕십리역 2호선"]); // 5호선은 50m → 같은 곳
  assert.deepEqual(pickCandidates("경희대학교", nearby).map((c) => c.name), ["경희대학교 서울캠퍼스"]);
  assert.deepEqual(pickCandidates("왕십리역요진", nearby).map((c) => c.name), ["왕십리역요진와이하우스오피스텔"]); // 붙여 쓴 검색어는 그대로
});
