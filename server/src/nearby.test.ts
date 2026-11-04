import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { busBoard, nearbyBoards, subwayLines } from "./nearby.js";

test("busBoard: 가까운 정류장의 모든 노선, 빨리 오는 순 (가짜 서버)", async () => {
  const srv = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    res.setHeader("content-type", "application/json");
    if (u.pathname.endsWith("getStationByPos"))
      return res.end(JSON.stringify({ msgBody: { itemList: [{ stationNm: "먼 정류장", arsId: "1", dist: "250" }, { stationNm: "회기역", arsId: "06176", dist: "40" }] } }));
    assert.equal(u.searchParams.get("arsId"), "06176");
    res.end(JSON.stringify({ msgBody: { itemList: [
      { rtNm: "273", arrmsg1: "5분12초후[3번째 전]", arrmsg2: "12분후[7번째 전]" },
      { rtNm: "1215", arrmsg1: "곧 도착", arrmsg2: "운행종료" },
      { rtNm: "N62", arrmsg1: "출발대기", arrmsg2: "" },
    ] } }));
  }).listen(0);
  const port = (srv.address() as { port: number }).port;
  const b = await busBoard(127, 37.5, "k", `http://127.0.0.1:${port}`);
  srv.close();
  assert.deepEqual(b, { kind: "bus", name: "회기역", distance: 40, lines: [{ line: "1215", times: ["곧 도착"], etas: [0] }, { line: "273", times: ["6분", "12분"], etas: [312, 720] }] });
});

test("subwayLines: 호선·방향별", () => {
  const text = JSON.stringify({ realtimeArrivalList: [
    { subwayId: "1001", trainLineNm: "청량리행 - 회기방면", barvlDt: "0", arvlMsg2: "[2]번째 전역 (신이문)" },
    { subwayId: "1001", trainLineNm: "청량리행 - 회기방면", barvlDt: "420", arvlMsg2: "7분 후" },
    { subwayId: "1063", trainLineNm: "문산행 - 청량리방면", barvlDt: "50", arvlMsg2: "곧 도착" },
  ] });
  assert.deepEqual(subwayLines(text), [
    { line: "경의중앙선 문산행", times: ["곧 도착"], etas: [50] },
    { line: "1호선 청량리행", times: ["2역 전", "7분"], etas: [null, 420] }, // "2역 전"은 어림값이라 안경이 줄이지 않음
  ]);
});

test("nearbyBoards: 위치 없으면 안내", async () => {
  const m = await nearbyBoards(null, { kakao: "k" });
  assert.equal(m.note, "현재 위치 없음 (Overland 확인)");
});
