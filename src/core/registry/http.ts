/**
 * HTTP transport for registry requests.
 *
 * WHY node:https AND NOT global fetch — this is not a style preference.
 *
 * Node's global `fetch` is undici, and undici does not use `http.globalAgent`.
 * VS Code's proxy support (`http.proxySupport`, default "override") works by
 * patching the global http/https agents via @vscode/proxy-agent. So a global
 * `fetch` call silently ignores the user's `http.proxy` setting.
 *
 * That breaks exactly the users the .npmrc registry resolution exists to serve:
 * corporate proxy and Artifactory users, who would get a table full of network
 * errors on first run. The failure is invisible outside a corporate network, so
 * it would not show up in normal testing or in a reproducible bug report.
 *
 * node:https costs no dependency, inherits VS Code's agent patching for free,
 * and still supports AbortSignal.
 *
 * Refs: nodejs/node#42814, nodejs/undici#3509.
 */

import { request } from 'node:https';
import { createGunzip, createBrotliDecompress } from 'node:zlib';
import type { Readable } from 'node:stream';

/** Registry responses are small; anything larger is refused rather than buffered. */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export type FetchErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'TOO_MANY_REDIRECTS'
  | 'BAD_URL'
  | 'REGISTRY_404'
  | 'REGISTRY_5XX'
  | 'RATE_LIMITED'
  | 'PARSE_ERROR'
  | 'CANCELLED';

export class FetchError extends Error {
  readonly code: FetchErrorCode;
  readonly status?: number;

  constructor(code: FetchErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }

  /** Whether retrying the same request could plausibly succeed. */
  get retryable(): boolean {
    return this.code === 'NETWORK' || this.code === 'TIMEOUT' || this.code === 'REGISTRY_5XX';
  }
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  /** Decompressed body. Empty string on 304. */
  body: string;
  /** Bytes counted on the raw socket, before decompression. 0 on a bodyless 304. */
  wireBytes: number;
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpClient {
  get(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
}

function decompress(stream: Readable, encoding: string | undefined): Readable {
  if (encoding === 'gzip' || encoding === 'deflate') return stream.pipe(createGunzip());
  if (encoding === 'br') return stream.pipe(createBrotliDecompress());
  return stream;
}

/**
 * HttpClient backed by node:https.
 *
 * Redirects are followed manually so each hop's scheme can be re-validated —
 * an automatic follower would happily downgrade to http: or land on an
 * attacker-supplied host.
 */
export class NodeHttpClient implements HttpClient {
  async get(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    let current = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.once(current, options);

      const isRedirect =
        response.status === 301 ||
        response.status === 302 ||
        response.status === 307 ||
        response.status === 308;

      if (!isRedirect) return response;

      const location = response.headers['location'];
      if (location === undefined) {
        throw new FetchError('NETWORK', `redirect with no location from ${current}`);
      }
      const next = new URL(location, current);
      if (next.protocol !== 'https:') {
        throw new FetchError('BAD_URL', `refusing non-https redirect to ${next.protocol}//`);
      }
      current = next.toString();
    }

    throw new FetchError('TOO_MANY_REDIRECTS', `more than ${MAX_REDIRECTS} redirects from ${url}`);
  }

  private once(url: string, options: HttpRequestOptions): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        reject(new FetchError('BAD_URL', `not a valid URL: ${url}`));
        return;
      }
      if (parsed.protocol !== 'https:') {
        reject(new FetchError('BAD_URL', `only https is supported, got ${parsed.protocol}`));
        return;
      }

      const signal = options.signal;
      if (signal?.aborted === true) {
        reject(new FetchError('CANCELLED', 'aborted before request started'));
        return;
      }

      // node:https throws a raw TypeError on an undefined header value. Callers
      // routinely build headers from optional values (a cached ETag that may
      // not exist), so drop empties here rather than crashing outside the
      // FetchError contract.
      const headers: Record<string, string> = { 'accept-encoding': 'gzip' };
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        if (typeof value === 'string' && value !== '') headers[key] = value;
      }

      const req = request(
        {
          protocol: parsed.protocol,
          host: parsed.hostname,
          port: parsed.port === '' ? undefined : parsed.port,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers,
        },
        (res) => {
          let wireBytes = 0;
          res.on('data', (chunk: Buffer) => {
            wireBytes += chunk.length;
          });

          const status = res.statusCode ?? 0;
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            headers[k] = Array.isArray(v) ? v.join(', ') : v;
          }

          // 304 carries no body by definition; don't wait on a decompressor
          // that will never receive bytes.
          if (status === 304) {
            res.resume();
            res.on('end', () => resolve({ status, headers, body: '', wireBytes }));
            return;
          }

          const body = decompress(res, res.headers['content-encoding']);
          const chunks: Buffer[] = [];
          let total = 0;
          let aborted = false;

          body.on('data', (chunk: Buffer) => {
            if (aborted) return;
            total += chunk.length;
            if (total > MAX_RESPONSE_BYTES) {
              aborted = true;
              req.destroy();
              reject(new FetchError('TOO_LARGE', `response exceeded ${MAX_RESPONSE_BYTES} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          body.on('end', () => {
            if (aborted) return;
            resolve({
              status,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
              wireBytes,
            });
          });
          body.on('error', (err: Error) => {
            if (aborted) return;
            reject(new FetchError('NETWORK', err.message));
          });
        }
      );

      req.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
        req.destroy();
        reject(new FetchError('TIMEOUT', `timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
      });

      req.on('error', (err: Error) => {
        reject(
          signal?.aborted === true
            ? new FetchError('CANCELLED', 'aborted')
            : new FetchError('NETWORK', err.message)
        );
      });

      const onAbort = (): void => {
        req.destroy();
        reject(new FetchError('CANCELLED', 'aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      req.end();
    });
  }
}

/** Map an unexpected HTTP status onto a typed error. */
export function errorForStatus(status: number, url: string): FetchError {
  if (status === 404) return new FetchError('REGISTRY_404', `not found: ${url}`, 404);
  if (status === 429) return new FetchError('RATE_LIMITED', `rate limited: ${url}`, 429);
  if (status >= 500) return new FetchError('REGISTRY_5XX', `server error ${status}: ${url}`, status);
  return new FetchError('NETWORK', `unexpected status ${status}: ${url}`, status);
}
