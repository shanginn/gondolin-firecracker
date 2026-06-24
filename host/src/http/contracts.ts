import type dns from "dns";
import type net from "net";
import type tls from "tls";
import type { Agent, fetch as undiciFetch } from "undici";

export type HttpFetch = typeof undiciFetch;

export const DEFAULT_MAX_HTTP_BODY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES =
  DEFAULT_MAX_HTTP_BODY_BYTES;

/** internal marker for onRequest hooks safe for pre-body policy precheck */
export const ON_REQUEST_EARLY_POLICY_SAFE = Symbol.for(
  "gondolin.http.onRequestEarlyPolicySafe",
);

export type HttpOnRequestHook = ((
  request: Request,
) => Promise<Request | Response | void> | Request | Response | void) & {
  /** internal marker enabling pre-body policy checks */
  [ON_REQUEST_EARLY_POLICY_SAFE]?: boolean;
};

export type HttpIpAllowInfo = {
  /** request hostname */
  hostname: string;
  /** resolved ip address */
  ip: string;
  /** ip family */
  family: 4 | 6;
  /** destination port */
  port: number;
  /** url protocol */
  protocol: "http" | "https";
};

export type HttpHooks = {
  /** allow/deny callback for request content (request body is always `null`) */
  isRequestAllowed?: (request: Request) => Promise<boolean> | boolean;
  /** allow/deny callback for resolved destination ip */
  isIpAllowed?: (info: HttpIpAllowInfo) => Promise<boolean> | boolean;
  /** request hook (may rewrite request or short-circuit with response) */
  onRequest?: HttpOnRequestHook;
  /** response rewrite hook */
  onResponse?: (
    response: Response,
    request: Request,
  ) => Promise<Response | void> | Response | void;
};

export type DnsMode = "open" | "trusted" | "synthetic";

export type SyntheticDnsHostMappingMode = "single" | "per-host";

export type DnsOptions = {
  /** dns mode */
  mode?: DnsMode;
  /** trusted resolver ipv4 addresses (mode="trusted") */
  trustedServers?: string[];
  /** synthetic A response ipv4 address (mode="synthetic") */
  syntheticIPv4?: string;
  /** synthetic AAAA response ipv6 address (mode="synthetic") */
  syntheticIPv6?: string;
  /** synthetic response ttl in `seconds` (mode="synthetic") */
  syntheticTtlSeconds?: number;
  /** synthetic hostname mapping strategy (mode="synthetic") */
  syntheticHostMapping?: SyntheticDnsHostMappingMode;
};

export type SharedDispatcherEntry = {
  dispatcher: Agent;
  lastUsedAt: number;
};

export type HttpBackendTcpSession = {
  socket: net.Socket | null;
  srcIP: string;
  srcPort: number;
  dstIP: string;
  dstPort: number;
  connectIP: string;
  syntheticHostname: string | null;
  flowControlPaused: boolean;
  connected: boolean;
  pendingWrites: Buffer[];
  pendingWriteBytes: number;
  protocol: string | null;
  http?: any;
  tls?: {
    socket: tls.TLSSocket;
  };
  ws?: any;
  ssh?: any;
};

export type HttpDispatchBackend<
  TSession extends HttpBackendTcpSession = HttpBackendTcpSession,
> = {
  options: {
    debug?: boolean;
    fetch?: HttpFetch;
    httpHooks?: HttpHooks;
    dnsLookup?: (
      hostname: string,
      options: dns.LookupAllOptions,
      callback: (
        err: NodeJS.ErrnoException | null,
        addresses: dns.LookupAddress[],
      ) => void,
    ) => void;
  };
  tcpSessions: Map<string, TSession>;
  http: {
    maxHttpBodyBytes: number;
    maxHttpResponseBodyBytes: number;
    allowWebSockets: boolean;
    webSocketUpstreamConnectTimeoutMs: number;
    webSocketUpstreamHeaderTimeoutMs: number;
    sharedDispatchers: Map<string, SharedDispatcherEntry>;
  };
  emitDebug(message: string): void;
};
