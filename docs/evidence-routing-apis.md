# 한국 보행자 경로 안내 서버용 경로 API 근거 검증

조사일: 2026-11-04. 판정: [확인] 1차 출처(공식 문서·직접 호출)로 확인, [부분확인] 일부만 확인 또는 간접 근거, [반증] 주장과 반대로 확인, [미확인] 확인 못 함.
"추정"이라고 적은 것은 근거 없는 내 해석이다. 가격과 한도는 자주 바뀌므로 개발 직전에 콘솔에서 다시 확인해야 한다.

## 1) TMAP 보행자 경로안내 API (SK open API)

| 항목 | 판정 | 근거 |
|---|---|---|
| API 존재 | 확인 | SK open API 요금 페이지 메뉴에 "보행자 경로 안내"가 있고, 요금표에도 "경로안내" 그룹 아래에 "보행자 경로안내"가 있다. https://openapi.sk.com/products/calc?svcSeq=4&menuSeq=5 |
| 요청 형식 | 부분확인 | 공식 문서 본문은 SPA라 가져오지 못했고, 개발자 블로그 글로 확인했다. `POST https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1`, 헤더 `appKey`, 필수 `startX/startY/endX/endY`, 선택 `startName/endName`. https://injae7034.github.io/kotlin/tmap-open-api-pedestrian |
| 응답: turn-by-turn, polyline | 부분확인 | 같은 블로그 기준 GeoJSON `FeatureCollection`이다. `Point` feature에 `turnType`, `description`, `direction`, `nearPoiName`, `intersectionName`이 있고, `LineString` feature의 `coordinates`가 polyline이며 `distance`, `time`, `roadType`이 붙는다. 좌표는 경도, 위도 순서다. 원문: "FeatureCollection의 가장 첫번째 Feature(geometry type: Point)의 properties에만 포함"(totalDistance, totalTime). `turnType` 코드표는 이 출처에 없어 미확인이다. 경유지 최대 5개라는 주장도 velog 글(https://velog.io/@ghenmaru/TMAP-TMAP-API-도보-길찾기)의 2차 출처뿐이다. |
| 무료 호출 한도 | 부분확인 | 요금표 원문: "경로안내 자동차 경로안내 1,000건 / 일 10,000건 / 일 11원 / 건 보행자 경로안내 타임머신 경로안내 이미지 경로 화물차 경로안내". 병합 셀로 보이며, 이에 따라 보행자 경로안내의 Free는 1,000건/일, Lite는 10,000건/일(월 2,200,000원, VAT 포함), Premium은 11원/건이라고 읽는다. 이 해석은 추정이다. 같은 표에서 POI 검색과 지오코딩의 Free는 각 20,000건/일이다. 동일 URL |
| 개인/비상업 사용 약관 | 미확인 | 이용약관 페이지를 가져오지 못했다(openapi.sk.com/terms 등은 404). 요금 페이지 문구는 "무료체험 Free: 무료로 사용할 수 있습니다."뿐이며 상업·비상업 구분이 없다. 약관 원문을 계정 가입 후 직접 읽어야 한다. |

참고: TMAP 대중교통 API는 별도 상품이다(`/transit/routes`). https://transit.tmapmobility.com/guide/procedure 이 페이지에는 요금 정보가 없다.

## 2) 네이버 지도 Directions 5/15

| 항목 | 판정 | 근거 |
|---|---|---|
| Directions 15가 자동차 전용 | 확인 | 원문: "단, Directions 15 API가 제공하는 경로 정보는 자동차에 한해서만 제공됩니다." https://guide.ncloud-docs.com/docs/maps-direction15-api |
| Directions 5가 자동차 전용 | 부분확인 | 공식 개요는 "Directions 5 경로 탐색(경유지 최대 5개)"라고만 쓴다(https://api.ncloud-docs.com/docs/application-maps-overview). 이동수단 문구는 직접 확인하지 못했다. Directions 5와 15는 경유지 수만 다른 동일 계열로 보이므로 자동차 전용일 가능성이 높지만, 이는 추정이다. |
| 보행자 경로 | 부분확인 | 공식 개요의 API 목록은 Static Map, Geocoding, Reverse Geocoding, Directions 5, Directions 15뿐이고 보행자 API는 없다. 목록에 없다는 사실에 근거한 간접 확인이다. |
| 대중교통 | 부분확인 | 위 목록에 대중교통 API가 없다. 검색 결과에서 "자동차 길찾기 외 기능은 추후 제공 예정"이라는 안내를 보았다고 했으나 원문 페이지는 확인하지 못했다. |

## 3) 카카오 모빌리티 / 카카오맵 API

| 항목 | 판정 | 근거 |
|---|---|---|
| "자동차만 제공" 주장 | 반증 | 카카오맵 REST API 문서에 도보 경로 조회가 있다. 원문: "지정한 출발지와 도착지 좌표의 도보 경로를 반환합니다." `GET https://dapi.kakao.com/v2/routing/walk`, 헤더 `Authorization: KakaoAK ${REST_API_KEY}`. 같은 문서에 `routing/bicycle`과 `routing/publictraffic`(대중교통)도 있다. https://developers.kakao.com/docs/ko/kakaomap/rest-api, https://developers.kakao.com/docs/ko/kakaomap/common ("출발지와 도착지 좌표 기준 대중교통, 도보, 자전거 경로 조회"). 단, 카카오내비(모빌리티) 쪽 REST는 자동차 길찾기 계열이다. 주장은 모빌리티 API에 한해서만 맞다. |
| 요청/응답 | 확인 | 요청: `start_x/start_y/end_x/end_y`, `via_x/via_y`(경유지 최대 5개), `route_mode`(`BROAD_FIRST` 기본, `SHORTEST`, `ACCESSIBLE`), `input_coord`/`output_coord`(`WGS84` 기본 등). 응답: `route.properties.totalDistance`(m), `totalTime`(초), `landingUrl`, `legs[].steps[]`의 `guidance`(안내 문구), `distance`, `time`, `x`, `y`, `path.points`([x,y] 좌표 배열). `status` 값은 `OK`, `SAME_POINT`, `START_LINK_NOT_FOUND`, `END_LINK_NOT_FOUND`, `TOO_FAR_AWAY`, `ROUTE_RESULT_NOT_FOUND` 등이다. 문서에 `turnType` 같은 회전 코드는 없고 guidance 문자열만 있다. |
| 무료 쿼터 | 확인 | 쿼터 문서(일간 쿼터)에서 카카오맵(REST API) 도보 경로 조회 1,000건, 대중교통 1,000건, 자전거 1,000건. 키워드로 장소 검색 100,000건, 주소로 좌표 변환 100,000건. 카카오내비 REST의 자동차 길찾기는 10,000건. https://developers.kakao.com/docs/ko/getting-started/quota |
| 무료 쿼터 조건 | 확인 | 2026년 7월 21일부터 방식이 바뀌어 무료 쿼터는 개발자 계정 기준 카카오맵 API를 처음 활성화한 앱 하나에만 제공된다. 두 번째 앱부터는 유료 API 설정이 필요하다(kakaomap/common 문서 "이용 정책"). |
| 상업/개인 약관 | 미확인 | 도보 API 고유의 약관은 확인하지 못했다. 카카오내비 자동차 API에 대해 개발자 포럼 답변이 서로 엇갈린다(비상업은 별도 제휴 없이 사용, 상업은 사전 제휴 필요). 이는 포럼 글이라 2차 출처다. |

## 4) OSRM (공개 데모 / 자체 호스팅 foot)

| 항목 | 판정 | 근거 |
|---|---|---|
| router.project-osrm.org의 foot 프로파일 | 반증(직접 호출) | 서울 시청 근처 두 점(126.9769,37.5759 → 126.9882,37.5512)으로 `/route/v1/car/`와 `/route/v1/foot/`을 호출하니 결과가 완전히 같았다(distance 7741.5 m, duration 1328.1 s). 프로파일 URL 부분이 무시되고 자동차 경로가 나온 것이다. 반면 FOSSGIS 보행 전용 엔드포인트 `https://routing.openstreetmap.de/routed-foot/route/v1/foot/...`은 3812 m, 3049.6 s로 보행 결과를 돌려줬다. 데모 서버의 foot 이용은 routing.openstreetmap.de 쪽을 써야 한다. |
| 사용 정책 | 확인 | 원문: "Do not exceed 1 request per second." 목적은 합리적인 비상업 용도로 제한된다. 가동 시간, 지연, 데이터 갱신에 대한 보장이 없다. https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server 구 정책 문서에는 "Excessive use is not allowed", 유효한 User-Agent, ODbL와 OSRM 출처 표기, 접근권을 언제든 철회할 수 있음이 있다. https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy 서비스용으로는 부적합하다. |
| 자체 호스팅 | 부분확인 | osrm-backend는 `foot.lua` 프로파일을 제공하며 자체 호스팅이 가능하다. 위 위키가 "공개 데모의 프로파일은 기본 osrm-backend 프로파일과 다르다(특히 bike, foot)"고 밝히고 있다. 한국 extract(Geofabrik 등)로 직접 구성한 사례는 이번에 확인하지 못했다. |
| 한국 OSM 데이터 품질 | 부분확인 | 서울(Overpass, 2026-11-04 질의)에서 `highway=footway + footway=sidewalk`는 8,537개, 횡단보도 `footway=crossing`은 7,414개, 일반 도로(trunk/primary/secondary/tertiary/residential/unclassified)는 46,529개였다. 단순 개수라 길이나 연결성 비교가 아니며, 인도가 도로의 별도 선으로 얼마나 매핑됐는지 가늠하는 참고치일 뿐이다. 추정: 도로 대비 인도 개수가 적어 인도 연결 그래프가 도로 전체를 덮지는 못한다. 2009년 국가교통DB 도로 import가 중복과 단절 문제를 일으켰다는 메일링리스트 글이 있다(https://lists.openstreetmap.org/pipermail/talk-ko/2018-July/000373.html). 한국 전체 인도 완성도 통계는 찾지 못했다(미확인). 정부 데이터 import는 라이선스(KOGL) 호환성 이슈가 있다. |

## 5) Google Directions / Routes API의 한국 제약

| 항목 | 판정 | 근거 |
|---|---|---|
| 한국에서 도보/대중교통이 제한된다는 주장 | 부분확인 | 제한의 원인(고정밀 지도 데이터의 국외 반출 금지)은 여러 매체가 설명한다. 2026-02-27 TechCrunch는 구글이 조건부 반출 승인을 받았고 "walking and real-time driving directions"가 가능해진다고 보도했다. 조건: 좌표 데이터 제거/제한, 국내 파트너 서버 처리, 군사시설 블러, 정부 검증. https://techcrunch.com/2026/02/27/south-korea-opens-the-door-to-let-google-maps-operate-fully/ |
| 현재(2026-11) Routes API가 한국에서 WALK/TRANSIT을 돌려주는가 | 미확인 | Routes API 공식 coverage 문서(https://developers.google.com/maps/documentation/routes/coverage)에는 한국 관련 서술이 없었고(양륜차·통행료 하위 링크만 존재), 승인 이후 실제 개시를 확인한 1차 출처를 찾지 못했다. API 키가 없어 직접 호출 검증도 하지 못했다. 설계에 쓰기 전에 키로 서울 좌표를 직접 호출해 보아야 한다. |

## 6) 지오코딩(장소명 → 좌표)

| 항목 | 판정 | 근거 |
|---|---|---|
| 카카오 로컬(키워드로 장소 검색) | 확인 | 일간 쿼터 100,000건(주소로 좌표 변환도 100,000건). 쿼터 문서 위 3)과 동일 출처. 무료 쿼터는 첫 활성화 앱 한 개에만 제공. |
| TMAP POI | 확인 | 요금표 원문: "POI 검색 20,000건 / 일 50,000건 / 일 1.1원 / 건", "지오코딩 20,000건 / 일 50,000건 / 일 0.55원 / 건" (Free / Lite / Premium 순). https://openapi.sk.com/products/calc?svcSeq=4&menuSeq=5 |
| 네이버 검색(지역 검색) | 부분확인 | 네이버 API가 NAVER API HUB로 이관됐고 한도는 월 단위 통합이라는 블로그 글들이 있다. 검색 API 일 25,000건, 월 약 775,000건이라는 수치는 블로그·개인 기록뿐이다. 공식 문서(https://guide.ncloud-docs.com/docs/apihub-use)에는 한도 수치가 없었다. 지역 검색만의 한도는 미확인이다. 또한 네이버 지역 검색은 결과 좌표가 제한적이라는 점은 이번에 검증하지 않았다(추정 없음). |

## 종합 판단 (추정 포함)

- 보행자 turn-by-turn을 한국에서 공식 제공하는 후보는 TMAP과 카카오맵(`routing/walk`)이다. 네이버와 Google은 현재 근거로는 후보가 아니다.
- 카카오 도보는 `guidance`와 `path.points`를 주지만 회전 코드가 없어, 안내 방향을 구조화하려면 TMAP의 `turnType`이 유리하다(추정).
- 무료 한도는 두 API 모두 하루 1,000건 수준(카카오 확인, TMAP은 병합 셀 해석)이므로 서버에서 캐싱 또는 호출 제한이 필요하다. 다만 카카오 포럼 답변은 길찾기 결과 캐싱이 금지될 수 있다고 하므로 약관을 먼저 확인해야 한다.
- OSRM은 공개 서버로 서비스하면 안 되고, 쓰려면 자체 호스팅한 foot 프로파일에 한국 OSM extract를 쓰되 인도 데이터 품질 검증이 선행되어야 한다.

## 대중교통 (2026-11-04 직접 호출)
- `GET dapi.kakao.com/v2/routing/publictraffic?start_x=&start_y=&end_x=&end_y=` (도보와 같은 파라미터) → 200.
- 외대앞역 근처 → 왕십리역: 후보 15개 (`properties.bus` 8, `subway` 3, `busAndSubway` 4). 카카오맵 링크 `landingURL`.
- 경로마다 `properties`: `type`(SUBWAY/BUS/BUS_AND_SUBWAY), `totalDistance`, `totalTime`(s), `transfers`, `fare.value`.
- 구간 `steps[].properties`: `type`(SUBWAY/BUS/WALKING), `guidance`(예: `간선 421 (제기역약령시장 > 성동구청)`), `distance`, `time`, `stops[].name`(**중간 정류장 전부**), `vehicles[].name`(같은 구간을 타는 노선들, 예: `141외 3대`). `steps[].path.points` 좌표 있음(환승 도보 포함).
- **없는 것:** 실시간 도착 정보, 정류장/역 ID(이름만), 출발지→첫 정류장·마지막 정류장→도착지 도보 구간(첫 구간이 바로 SUBWAY/BUS 로 시작).
- 실시간 도착은 별도 API 필요 (명세 미검증, 검색 결과 기준):
  - 서울 지하철: 서울 열린데이터광장 실시간 도착정보 `realtimeStationArrival` (역명으로 조회, data.seoul.go.kr 키). https://bsh-developer.tistory.com/798
  - 서울 버스: 서울특별시_버스도착정보조회 서비스 (data.go.kr 키, 도착 예정 초·몇 번째 전 정류소). https://www.data.go.kr/data/15000314/openapi.do
  - 경기 버스: 경기도_버스도착정보 조회 (data.go.kr 키, stationId 필요). https://www.data.go.kr/data/15080346/openapi.do
  - 이 세션에서 `ws.bus.go.kr`, `swopenapi.seoul.go.kr`, `apis.data.go.kr`, `openapi.seoul.go.kr` 은 네트워크 정책으로 403.
