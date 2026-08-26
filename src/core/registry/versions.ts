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
import { isSafeNpmPackageName, isSafeSemverVersion } from '../upgrade/plan.js';
import type { HttpClient } from './http.js';
import { FetchError, errorForStatus } from './http.js';
import { runPool, DEFAULT_CONCURRENCY } from './pool.js';
import type { Settled } from './pool.js';

export const ABBREVIATED_ACCEPT = 'application/vnd.npm.install-v1+json';
const MAX_DESCRIPTION_LENGTH = 500;

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
  description?: string;
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
  if (typeof json['description'] === 'string' && json['description'].trim() !== '') {
    doc.description = json['description'].trim().slice(0, MAX_DESCRIPTION_LENGTH);
  }
  if (typeof json['license'] === 'string') doc.license = json['license'];
  if (typeof json['deprecated'] === 'string') doc.deprecated = json['deprecated'];
  return doc;
}

export interface PackumentDoc {
  versions: string[];
  distTags: Record<string, string>;
}

/**
 * GET the registry's small dist-tags document without downloading every
 * published manifest. This is the fallback for packages whose abbreviated
 * packument is still too large for the extension-host response budget.
 */
export async function fetchDistTags(
  client: HttpClient,
  store: EtagStore,
  registry: string,
  name: string,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const url = joinUrl(registry, `-/package/${encodePackageName(name)}/dist-tags`);
  const { body } = await getConditional(client, store, url, 'application/json', signal);
  const json = parseJson(body, url);
  const distTags: Record<string, string> = {};
  for (const [tag, value] of Object.entries(json)) {
    if (tag !== '__proto__' && tag !== 'constructor' && tag !== 'prototype' && typeof value === 'string') {
      distTags[tag] = value;
    }
  }
  return distTags;
}

/**
 * The small, resolver-relevant subset of one published package manifest.
 *
 * This is deliberately separate from `VersionInfo`: the dashboard's normal
 * version scan only needs a version number, while compatibility preflight
 * needs dependency relationships for exactly the version being considered.
 * Fetching this document is therefore an explicit, lazy operation and is
 * never part of `fetchAllVersions`.
 */
export interface PackageVersionMetadata {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional: boolean }>;
  /** Exact-version runtime requirements used by project compatibility analysis. */
  engines?: Record<string, string>;
  /** Published command names. Values are paths only; they are never executed by analysis. */
  bin?: string | Record<string, string>;
  /** Published package export map, retained as bounded JSON for subpath checks. */
  exports?: unknown;
  /** True when the registry export map exceeded safety bounds; absence can no longer be proven from it. */
  exportsTruncated?: boolean;
}

function readStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

function readPeerMeta(value: unknown): Record<string, { optional: boolean }> {
  const out: Record<string, { optional: boolean }> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (typeof raw !== 'object' || raw === null) continue;
    const optional = (raw as Record<string, unknown>)['optional'];
    if (typeof optional === 'boolean') out[key] = { optional };
  }
  return out;
}

function readBin(value: unknown): string | Record<string, string> | undefined {
  if (typeof value === 'string') return value;
  const entries = readStringMap(value);
  return Object.keys(entries).length === 0 ? undefined : entries;
}

/** Registry-controlled JSON stays data-only and bounded before analyzers inspect it. */
function readBoundedPackageMap(
  value: unknown,
  depth = 0,
  budget = { remaining: 5_000, truncated: false }
): unknown {
  if (budget.remaining <= 0 || depth > 12) {
    budget.truncated = true;
    return undefined;
  }
  budget.remaining -= 1;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.length > 1_000) budget.truncated = true;
    return value
      .slice(0, 1_000)
      .map((entry) => readBoundedPackageMap(entry, depth + 1, budget))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const parsed = readBoundedPackageMap(raw, depth + 1, budget);
    if (parsed !== undefined) out[key] = parsed;
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
  }
  return out;
}

/**
 * Fetch resolver metadata for one exact version.
 *
 * The exact-version endpoint is intentionally used instead of downloading a
 * full packument merely to inspect one proposed release. Both the package name
 * and version remain literal URL path components; callers are still expected
 * to validate them as host-owned npm identifiers before calling this function.
 */
export async function fetchPackageVersionMetadata(
  client: HttpClient,
  store: EtagStore,
  registry: string,
  name: string,
  version: string,
  signal?: AbortSignal
): Promise<PackageVersionMetadata> {
  // Defense in depth: unlike the dashboard's broad version lookup, this
  // endpoint is intended only for an exact, host-owned upgrade candidate.
  // Refuse anything that could alter URL path structure before touching the
  // network, even if a future caller forgets the preflight boundary's check.
  if (!isSafeNpmPackageName(name) || !isSafeSemverVersion(version)) {
    throw new FetchError('BAD_URL', 'invalid package name or exact version for metadata lookup');
  }
  const url = joinUrl(registry, `${encodePackageName(name)}/${encodeURIComponent(version)}`);
  const { body } = await getConditional(client, store, url, 'application/json', signal);
  const json = parseJson(body, url);

  const publishedVersion = json['version'];
  if (typeof publishedVersion !== 'string' || publishedVersion !== version) {
    throw new FetchError('PARSE_ERROR', `registry metadata version mismatch from ${url}`);
  }

  const publishedName = json['name'];
  if (publishedName !== name) {
    throw new FetchError('PARSE_ERROR', `registry metadata package mismatch from ${url}`);
  }

  const metadata: PackageVersionMetadata = {
    name,
    version,
    dependencies: readStringMap(json['dependencies']),
    optionalDependencies: readStringMap(json['optionalDependencies']),
    peerDependencies: readStringMap(json['peerDependencies']),
    peerDependenciesMeta: readPeerMeta(json['peerDependenciesMeta']),
  };
  const engines = readStringMap(json['engines']);
  if (Object.keys(engines).length > 0) metadata.engines = engines;
  const bin = readBin(json['bin']);
  if (bin !== undefined) metadata.bin = bin;
  if (json['exports'] !== undefined) {
    const exportsBudget = { remaining: 5_000, truncated: false };
    metadata.exports = readBoundedPackageMap(json['exports'], 0, exportsBudget);
    if (exportsBudget.truncated) metadata.exportsTruncated = true;
  }
  return metadata;
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
  /** Optional scan-local loader used to share one packument across consumers. */
  packumentLoader?: (name: string, signal?: AbortSignal) => Promise<PackumentDoc>;
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
    if (latestDoc.description !== undefined) info.description = latestDoc.description;
    if (latestDoc.deprecated !== undefined) info.deprecated = latestDoc.deprecated;
    if (latestDoc.license !== undefined) info.license = latestDoc.license;
    return info;
  }

  let packument: PackumentDoc;
  try {
    packument = await (options.packumentLoader?.(req.name, signal) ??
      fetchPackument(client, store, registry, req.name, signal));
  } catch (cause) {
    if (!(cause instanceof FetchError) || cause.code !== 'TOO_LARGE') throw cause;
    const distTags = await fetchDistTags(client, store, registry, req.name, signal);
    const taggedVersions = new Set(Object.values(distTags));
    // The installed version is host-owned lockfile evidence and supplies a
    // truthful in-range floor when the registry exposes no maintained-line
    // tag for the declared range. `latest` still comes from the maintainer's
    // own dist-tag; this fallback never invents a release.
    if (req.installed !== null) taggedVersions.add(req.installed);
    packument = { versions: [...taggedVersions], distTags };
  }

  // Delegate to the existing selection rules — do not reimplement them here.
  const info: VersionInfo = {
    name: req.name,
    wanted: resolveWanted(packument.versions, req.range, req.installed),
    latest: resolveLatest(packument.versions, packument.distTags, req.installed),
  };
  if (latestDoc.description !== undefined) info.description = latestDoc.description;
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
        {
          client: options.client,
          store: options.store,
          registry: options.registry,
          ...(signal === undefined ? {} : { signal }),
          ...(options.packumentLoader === undefined ? {} : { packumentLoader: options.packumentLoader }),
        },
        req
      ),
    poolOptions
  );
}
