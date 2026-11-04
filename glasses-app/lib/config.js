// 서버 주소는 공개돼도 되지만 토큰은 비밀이다.
// GLASS_TOKEN 은 저장소에 커밋하지 말고, AIUI Studio 에서 프로젝트를 가져온 뒤 거기서만 채운다.
export const SERVER_WS = 'wss://route-server-production.up.railway.app/glass';
export const GLASS_TOKEN = '';
/** 위치를 서버로 보내는 최소 간격 (ms) */
export const POSITION_MIN_INTERVAL_MS = 2000;
