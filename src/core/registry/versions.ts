/**
 * Hybrid version fetching.
 *
 * Measured over 20 packages: the abbreviated packument costs 31x the wire bytes
 * and 54x the parse bytes of `/<pkg>/latest` (worst single case, mongoose:
 * 136.9x wire / 216.6x raw). The parse figure is the one that hurts — it is
 * JSON.parse on the extension host, shared with every other extension.
 *
 * So: fetch `/<pkg>/latest` for everyone. It answers "is there a newer stable
 * release", which is the common case, and it carries `license` and `deprecated`
 * for free. Escalate to the full version list only when it cannot answer:
 *
 *   - `latest` does not satisfy the declared range, so Wanted != Latest and the
 *     version list is the only way to find the highest in-range version; or
 *   - the installed version is a prerelease, where resolveLatest has to look at
 *     prereleases on the same line.
 *
 * Version selection itself is NOT implemented here — it delegates to
 * resolveWanted/resolveLatest, which already encode the canary/nightly rules.
 */

import semver from 'semver';

import type { VersionInfo } from '../types.js';
import { resolveWanted, resolveLatest, isPrerelease } from '../version/resolve.js';
import type { HttpClient } from './http.js';
import { FetchError, errorForStatus } from './http.js';
import { runPool, DEFAULT_CONCURRENCY } from './pool.js';
import type { Settled } from './pool.js';

export const ABBREVIATED_ACCEPT = 'application/vnd.npm.install-v1+json';

export interface CachedResponse {
  etag: string;
  body: string;
}

/**
 * ETag store. Registry data is project-independent, so the adapter should back
 * this with globalState rather than workspaceState.
 */
export interface EtagStore {
  get(key: string): CachedResponse | undefined;
  set(key: string, value: CachedResponse): void;
}

export class MemoryEtagStore implements EtagStore {
  private readonly entries = new Map<string, CachedResponse>();
  get(key: string): CachedResponse | undefined {
    return this.entries.get(key);
  }
  set(key: string, value: CachedResponse): void {
    this.entries.set(key, value);
  }
}

/** Scoped names must be encoded: @scope/name -> @scope%2fname. */
export function encodePackageName(name: string): string {
  return name.replace('/', '%2f');
}

function joinUrl(registry: string, path: string): string {
  return `${registry.replace(/\/+$/, '')}/${path}`;
}

/**
 * GET with conditional-request support.
 *
 * On 304 the registry sends no body, so the cached copy is returned and
 * `wireBytes` stays at whatever the headers cost — the point of the ETag.
 */
async function getConditional(
  client: HttpClient,
  store: EtagStore,
  url: string,
  accept: string,
  signal?: AbortSignal
): Promise<{ body: string; wireBytes: number; notModified: boolean }> {
  const cached = store.get(url);
  const headers: Record<string, string> = { accept };
  if (cached !== undefined) headers['if-none-match'] = cached.etag;

  const response = await client.get(url, signal === undefined ? { headers } : { headers, signal });

  if (response.status === 304) {
    if (cached === undefined) {
      throw new FetchError('NETWORK', `304 for ${url} with nothing cached`);
    }
    return { body: cached.body, wireBytes: response.wireBytes, notModified: true };
  }

  if (response.status !== 200) throw errorForStatus(response.status, url);

  const etag = response.headers['etag'];
  if (etag !== undefined) store.set(url, { etag, body: response.body });

  return { body: response.body, wireBytes: response.wireBytes, notModified: false };
}

function parseJson(body: string, url: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new FetchError('PARSE_ERROR', `invalid JSON from ${url}`);
  }
  if (typeof value !== 'object' || value === null) {
    throw new FetchError('PARSE_ERROR', `unexpected JSON shape from ${url}`);
  }
  return value as Record<string, unknown>;
}

export interface LatestDoc {
  version: string | null;
  license?: string;
  deprecated?: string;
}

/** GET /<pkg>/latest — small, and carries license + deprecated. */
export async function fetchLatest(
  client: HttpClient,
  store: EtagStore,
  registry: string,
  name: string,
  signal?: AbortSignal
): Promise<LatestDoc> {
  const url = joinUrl(registry, `${encodePackageName(name)}/latest`);
  const { body } = await getConditional(client, store, url, 'application/json', signal);
  const json = parseJson(body, url);

  const doc: LatestDoc = {
    version: typeof json['version'] === 'string' ? json['version'] : null,
  };
  if (typeof json['license'] === 'string') doc.license = json['license'];
  if (typeof json['deprecated'] === 'string') doc.deprecated = json['deprecated'];
  return doc;
}

export interface PackumentDoc {
  versions: string[];
  distTags: Record<string, string>;
}

/** GET /<pkg> with the abbreviated Accept header — the escalation path. */
export async function fetchPackument(
  client: HttpClient,
  store: EtagStore,
  registry: string,
  name: string,
  signal?: AbortSignal
): Promise<PackumentDoc> {
  const url = joinUrl(registry, encodePackageName(name));
  const { body } = await getConditional(client, store, url, ABBREVIATED_ACCEPT, signal);
  const json = parseJson(body, url);

  const versionsBlock = json['versions'];
  const versions =
    typeof versionsBlock === 'object' && versionsBlock !== null
      ? Object.keys(versionsBlock).filter((k) => k !== '__proto__')
      : [];

  const tagsBlock = json['dist-tags'];
  const distTags: Record<string, string> = {};
  if (typeof tagsBlock === 'object' && tagsBlock !== null) {
    for (const [tag, value] of Object.entries(tagsBlock)) {
      if (tag !== '__proto__' && typeof value === 'string') distTags[tag] = value;
    }
  }

  return { versions, distTags };
}

export interface VersionRequest {
  name: string;
  /** Declared range from package.json. */
  range: string;
  /** Lockfile-resolved version, or null when unresolved. */
  installed: string | null;
}

export interface FetchVersionOptions {
  client: HttpClient;
  store: EtagStore;
  registry: string;
  signal?: AbortSignal;
}

/**
 * True when `/latest` alone cannot answer, so the version list is required.
 */
export function needsPackument(
  latestVersion: string | null,
  range: string,
  installed: string | null
): boolean {
  // A prerelease install needs the sibling prereleases on its own line.
  if (installed !== null && isPrerelease(installed)) return true;
  if (latestVersion === null) return true;
  if (range === '' || range === '*' || range === 'latest') return false;
  // If latest satisfies the range it is also the highest in-range version,
  // so Wanted == Latest and the list adds nothing.
  return !semver.satisfies(latestVersion, range);
}

/**
 * Resolve one package's version info, escalating only when necessary.
 */
export async function fetchVersionInfo(
  options: FetchVersionOptions,
  req: VersionRequest
): Promise<VersionInfo> {
  const { client, store, registry, signal } = options;

  const latestDoc = await fetchLatest(client, store, registry, req.name, signal);

  if (!needsPackument(latestDoc.version, req.range, req.installed)) {
    const info: VersionInfo = {
      name: req.name,
      wanted: latestDoc.version,
      latest: latestDoc.version,
    };
    if (latestDoc.deprecated !== undefined) info.deprecated = latestDoc.deprecated;
    if (latestDoc.license !== undefined) info.license = latestDoc.license;
    return info;
  }

  const packument = await fetchPackument(client, store, registry, req.name, signal);

  // Delegate to the existing selection rules — do not reimplement them here.
  const info: VersionInfo = {
    name: req.name,
    wanted: resolveWanted(packument.versions, req.range, req.installed),
    latest: resolveLatest(packument.versions, packument.distTags, req.installed),
  };
  if (latestDoc.deprecated !== undefined) info.deprecated = latestDoc.deprecated;
  if (latestDoc.license !== undefined) info.license = latestDoc.license;
  return info;
}

/**
 * Resolve many packages, at most `limit` requests in flight.
 *
 * Returns one settled result per request in input order. A failure on any
 * single package is that package's own result — it never fails the batch.
 */
export async function fetchAllVersions(
  options: FetchVersionOptions & {
    limit?: number;
    onSettled?: (req: VersionRequest, result: Settled<VersionInfo>) => void;
  },
  requests: readonly VersionRequest[]
): Promise<Array<Settled<VersionInfo>>> {
  const poolOptions: Parameters<typeof runPool<VersionRequest, VersionInfo>>[2] = {
    limit: options.limit ?? DEFAULT_CONCURRENCY,
  };
  if (options.signal !== undefined) poolOptions.signal = options.signal;
  if (options.onSettled !== undefined) poolOptions.onSettled = options.onSettled;

  return runPool<VersionRequest, VersionInfo>(
    requests,
    (req, signal) =>
      fetchVersionInfo(
        signal === undefined
          ? { client: options.client, store: options.store, registry: options.registry }
          : { client: options.client, store: options.store, registry: options.registry, signal },
        req
      ),
    poolOptions
  );
}
