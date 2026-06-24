import type {
  InternalHeaderValue,
  InternalHttpResponseHeaders,
} from "../internal/http-types.ts";

export class HttpRequestBlockedError extends Error {
  status: number;
  statusText: string;

  constructor(
    message = "request blocked",
    status = 403,
    statusText = "Forbidden",
  ) {
    super(message);
    this.name = "HttpRequestBlockedError";
    this.status = status;
    this.statusText = statusText;
  }
}

export function parseHeaderLines(
  lines: Iterable<string>,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};

  for (const line of lines) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim().toLowerCase();
    if (!key) continue;

    const value = line.slice(idx + 1).trim();

    const prev = headers[key];
    if (prev === undefined) {
      headers[key] = value;
    } else if (Array.isArray(prev)) {
      prev.push(value);
    } else {
      headers[key] = [prev, value];
    }
  }

  return headers;
}

export function coalesceHeaderRecord(
  headers: Record<string, string | string[]>,
): Record<string, string> {
  // Use WHATWG Headers for coalescing rules (notably Cookie uses `; `
  // instead of `, `).
  const h = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        h.append(key, v);
      }
    } else {
      h.append(key, value);
    }
  }

  const out: Record<string, string> = {};
  for (const [key] of h) {
    const value = h.get(key);
    if (value !== null) {
      out[key.toLowerCase()] = value;
    }
  }
  return out;
}

export function parseContentLength(
  raw: string | string[] | undefined,
): number | null {
  if (raw === undefined) return null;
  const rawString = Array.isArray(raw) ? raw.join(",") : raw;
  const n = Number.parseInt(rawString, 10);
  if (!Number.isSafeInteger(n) || n < 0) {
    return null;
  }
  return n;
}

export const MAX_HTTP_HEADER_BYTES = 64 * 1024;

export type HttpWireVersion = "HTTP/1.0" | "HTTP/1.1";

function renderHttpResponseHead(
  response: {
    status: number;
    statusText: string;
    headers: InternalHttpResponseHeaders;
  },
  httpVersion: HttpWireVersion = "HTTP/1.1",
): string {
  const statusLine = `${httpVersion} ${response.status} ${response.statusText}\r\n`;

  const headerLines: string[] = [];
  for (const [rawName, rawValue] of Object.entries(response.headers)) {
    const name = rawName.replace(/[\r\n:]+/g, "");
    if (!name) continue;

    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const v of values) {
      const value = String(v).replace(/[\r\n]+/g, " ");
      headerLines.push(`${name}: ${value}`);
    }
  }

  let headerBlock = statusLine;
  if (headerLines.length > 0) {
    headerBlock += headerLines.join("\r\n") + "\r\n";
  }
  headerBlock += "\r\n";

  return headerBlock;
}

export function sendHttpResponseHead(
  write: (chunk: Buffer) => void,
  response: {
    status: number;
    statusText: string;
    headers: InternalHttpResponseHeaders;
  },
  httpVersion: HttpWireVersion = "HTTP/1.1",
  encoding: BufferEncoding = "utf8",
) {
  const head = renderHttpResponseHead(response, httpVersion);
  write(Buffer.from(head, encoding));
}

export function sendHttpResponse(
  write: (chunk: Buffer) => void,
  response: {
    status: number;
    statusText: string;
    headers: InternalHttpResponseHeaders;
    body: Buffer;
  },
  httpVersion: HttpWireVersion = "HTTP/1.1",
  encoding: BufferEncoding = "utf8",
) {
  sendHttpResponseHead(write, response, httpVersion, encoding);
  if (response.body.length > 0) {
    write(response.body);
  }
}

function joinInternalHeaderValue(raw: string | string[] | undefined): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.join(",");
  return "";
}

export function isWebSocketUpgradeRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const upgrade = joinInternalHeaderValue(headers["upgrade"]).toLowerCase();
  if (upgrade === "websocket") return true;

  // Some clients omit Upgrade/Connection but include the WebSocket-specific headers.
  if (headers["sec-websocket-key"] || headers["sec-websocket-version"]) {
    return true;
  }

  return false;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

export function stripHopByHopHeaders<T extends InternalHeaderValue>(
  this: any,
  headers: Record<string, T>,
): Record<string, T> {
  const connectionValue = headers["connection"];
  const connection = Array.isArray(connectionValue)
    ? connectionValue.join(",")
    : typeof connectionValue === "string"
      ? connectionValue
      : "";

  const connectionTokens = new Set<string>();
  if (connection) {
    for (const token of connection.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized) connectionTokens.add(normalized);
    }
  }

  const output: Record<string, T> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalizedName)) continue;
    if (connectionTokens.has(normalizedName)) continue;
    output[normalizedName] = value;
  }
  return output;
}

export function stripHopByHopHeadersForWebSocket<T extends InternalHeaderValue>(
  this: any,
  headers: Record<string, T>,
): Record<string, T> {
  const out: Record<string, T> = { ...headers };

  // Unlike normal HTTP proxying, WebSocket handshakes require forwarding Connection/Upgrade
  // Still strip proxy-only and framing hop-by-hop headers
  delete out["keep-alive"];
  delete out["proxy-connection"];
  delete out["proxy-authenticate"];
  delete out["proxy-authorization"];

  // No request bodies for WebSocket handshake
  delete out["content-length"];
  delete out["transfer-encoding"];
  delete out["expect"];

  // Avoid forwarding framed/trailer-related hop-by-hop headers
  delete out["te"];
  delete out["trailer"];

  // Apply Connection: token stripping, but keep Upgrade + WebSocket-specific headers
  const connectionValue = out["connection"];
  const connection = Array.isArray(connectionValue)
    ? connectionValue.join(",")
    : typeof connectionValue === "string"
      ? connectionValue
      : "";
  const tokens = connection
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const keepNominated = new Set([
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ]);

  for (const token of tokens) {
    if (keepNominated.has(token)) continue;
    delete out[token];
  }

  return out;
}

export type HttpRequestData = {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  body: Buffer;
};

export class HttpReceiveBuffer {
  private readonly chunks: Buffer[] = [];
  private totalBytes = 0;

  get length() {
    return this.totalBytes;
  }

  append(chunk: Buffer) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
  }

  resetTo(buffer: Buffer) {
    this.chunks.length = 0;
    this.totalBytes = 0;
    this.append(buffer);
  }

  /**
   * Find the start offset of the first "\r\n\r\n" sequence or -1 if missing
   */
  findHeaderEnd(maxSearchBytes: number): number {
    const pattern = [0x0d, 0x0a, 0x0d, 0x0a];
    let matched = 0;
    let index = 0;

    for (const chunk of this.chunks) {
      for (let i = 0; i < chunk.length; i += 1) {
        if (index >= maxSearchBytes) return -1;
        const b = chunk[i]!;

        if (b === pattern[matched]) {
          matched += 1;
          if (matched === pattern.length) {
            return index - (pattern.length - 1);
          }
        } else {
          // Only possible overlap is a new '\r'.
          matched = b === pattern[0] ? 1 : 0;
        }

        index += 1;
      }
    }

    return -1;
  }

  /**
   * Copies the first `n` bytes into a contiguous Buffer
   */
  prefix(n: number): Buffer {
    if (n <= 0) return Buffer.alloc(0);
    if (n >= this.totalBytes) return this.toBuffer();

    const out = Buffer.allocUnsafe(n);
    let written = 0;

    for (const chunk of this.chunks) {
      if (written >= n) break;
      const remaining = n - written;
      const take = Math.min(remaining, chunk.length);
      chunk.copy(out, written, 0, take);
      written += take;
    }

    return out;
  }

  /**
   * Copies the bytes from `start` (inclusive) to the end into a contiguous Buffer
   */
  suffix(start: number): Buffer {
    if (start <= 0) return this.toBuffer();
    if (start >= this.totalBytes) return Buffer.alloc(0);

    const outLen = this.totalBytes - start;
    const out = Buffer.allocUnsafe(outLen);
    let written = 0;
    let skipped = 0;

    for (const chunk of this.chunks) {
      if (skipped + chunk.length <= start) {
        skipped += chunk.length;
        continue;
      }

      const chunkStart = Math.max(0, start - skipped);
      const take = chunk.length - chunkStart;
      chunk.copy(out, written, chunkStart, chunkStart + take);
      written += take;
      skipped += chunk.length;
    }

    return out;
  }

  cursor(start = 0): HttpReceiveCursor {
    return new HttpReceiveCursor(this.chunks, this.totalBytes, start);
  }

  toBuffer(): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    if (this.chunks.length === 1) return this.chunks[0]!;
    return Buffer.concat(this.chunks, this.totalBytes);
  }
}

export class HttpReceiveCursor {
  private chunkIndex = 0;
  private chunkOffset = 0;
  offset: number;
  private readonly chunks: Buffer[];
  private readonly totalBytes: number;

  constructor(chunks: Buffer[], totalBytes: number, startOffset: number) {
    this.chunks = chunks;
    this.totalBytes = totalBytes;
    this.offset = startOffset;

    let remaining = startOffset;
    while (this.chunkIndex < this.chunks.length) {
      const chunk = this.chunks[this.chunkIndex]!;
      if (remaining < chunk.length) {
        this.chunkOffset = remaining;
        break;
      }
      remaining -= chunk.length;
      this.chunkIndex += 1;
    }

    if (this.chunkIndex >= this.chunks.length && remaining !== 0) {
      // Clamp: cursor can start at end, but never beyond.
      this.offset = this.totalBytes;
      this.chunkIndex = this.chunks.length;
      this.chunkOffset = 0;
    }
  }

  private cloneState() {
    return {
      chunkIndex: this.chunkIndex,
      chunkOffset: this.chunkOffset,
      offset: this.offset,
    };
  }

  private commitState(state: {
    chunkIndex: number;
    chunkOffset: number;
    offset: number;
  }) {
    this.chunkIndex = state.chunkIndex;
    this.chunkOffset = state.chunkOffset;
    this.offset = state.offset;
  }

  private readByteFrom(state: {
    chunkIndex: number;
    chunkOffset: number;
    offset: number;
  }) {
    if (state.offset >= this.totalBytes) return null;

    while (state.chunkIndex < this.chunks.length) {
      const chunk = this.chunks[state.chunkIndex]!;
      if (state.chunkOffset < chunk.length) {
        const b = chunk[state.chunkOffset]!;
        state.chunkOffset += 1;
        state.offset += 1;
        return b;
      }
      state.chunkIndex += 1;
      state.chunkOffset = 0;
    }

    return null;
  }

  remaining() {
    return Math.max(0, this.totalBytes - this.offset);
  }

  tryConsumeSequenceIfPresent(sequence: number[]): boolean | null {
    const state = this.cloneState();

    for (const expected of sequence) {
      const b = this.readByteFrom(state);
      if (b === null) return null;
      if (b !== expected) return false;
    }

    this.commitState(state);
    return true;
  }

  tryConsumeExactSequence(sequence: number[]): boolean | null {
    const consumed = this.tryConsumeSequenceIfPresent(sequence);
    if (consumed === null) return null;
    if (!consumed) {
      throw new Error("invalid chunk terminator");
    }
    return true;
  }

  tryReadLineAscii(maxBytes: number): string | null {
    const state = this.cloneState();
    const bytes: number[] = [];

    while (true) {
      const b = this.readByteFrom(state);
      if (b === null) return null;

      if (b === 0x0d) {
        const b2 = this.readByteFrom(state);
        if (b2 === null) return null;
        if (b2 !== 0x0a) {
          throw new Error("invalid line terminator");
        }

        this.commitState(state);
        return Buffer.from(bytes).toString("ascii");
      }

      bytes.push(b);
      if (bytes.length > maxBytes) {
        throw new Error("chunk size line too large");
      }
    }
  }

  tryReadBytes(n: number): Buffer | null {
    if (n === 0) return Buffer.alloc(0);
    if (this.remaining() < n) return null;

    const state = this.cloneState();
    const firstChunk = this.chunks[state.chunkIndex];
    if (firstChunk && state.chunkOffset + n <= firstChunk.length) {
      const slice = firstChunk.subarray(
        state.chunkOffset,
        state.chunkOffset + n,
      );
      state.chunkOffset += n;
      state.offset += n;
      this.commitState(state);
      return slice;
    }

    const out = Buffer.allocUnsafe(n);
    let written = 0;

    while (written < n) {
      const chunk = this.chunks[state.chunkIndex];
      if (!chunk) return null;

      if (state.chunkOffset >= chunk.length) {
        state.chunkIndex += 1;
        state.chunkOffset = 0;
        continue;
      }

      const available = chunk.length - state.chunkOffset;
      const take = Math.min(available, n - written);
      chunk.copy(out, written, state.chunkOffset, state.chunkOffset + take);
      state.chunkOffset += take;
      state.offset += take;
      written += take;
    }

    this.commitState(state);
    return out;
  }

  tryConsumeUntilDoubleCrlf(): boolean | null {
    const pattern = [0x0d, 0x0a, 0x0d, 0x0a];
    const state = this.cloneState();
    let matched = 0;

    while (true) {
      const b = this.readByteFrom(state);
      if (b === null) return null;

      if (b === pattern[matched]) {
        matched += 1;
        if (matched === pattern.length) {
          this.commitState(state);
          return true;
        }
      } else {
        matched = b === pattern[0] ? 1 : 0;
      }
    }
  }
}
