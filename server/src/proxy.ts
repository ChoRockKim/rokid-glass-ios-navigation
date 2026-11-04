// HTTPS_PROXY 가 있는 환경(사내망, 클라우드 샌드박스)에서만 프록시를 쓴다.
// Node 기본 fetch 와 Slack Socket Mode 의 WebSocket 은 프록시 환경 변수를 읽지 않아서 직접 넘겨야 한다.
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

const hasProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy);

export const dispatcher: Dispatcher | undefined = hasProxy ? new EnvHttpProxyAgent() : undefined;

/** Bolt 의 respond()(response_url → hooks.slack.com) 와 WebClient 에 넘길 fetch. 프록시가 없으면 undefined = 기본값 */
export const proxiedFetch: typeof globalThis.fetch | undefined = dispatcher
  ? (((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
      undiciFetch(input, { ...init, dispatcher })) as unknown as typeof globalThis.fetch)
  : undefined;
