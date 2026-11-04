// HTTPS_PROXY 가 있는 환경(사내망, 클라우드 샌드박스)에서만 프록시를 쓴다.
// Node 기본 fetch 와 Slack Socket Mode 의 WebSocket 은 프록시 환경 변수를 읽지 않아서 직접 넘겨야 한다.
import { EnvHttpProxyAgent, type Dispatcher } from "undici";

const hasProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy);

export const dispatcher: Dispatcher | undefined = hasProxy ? new EnvHttpProxyAgent() : undefined;
