/**
 * Optional CVE/GHSA alias enrichment for advisories already found by npm.
 *
 * npm's bulk endpoint is still the vulnerability detector. This module only
 * follows a trusted `github.com/advisories/GHSA-...` URL from that response
 * to GitHub's public Global Security Advisory API and copies its bounded,
 * validated identifier aliases. Failure is per-advisory and never removes or
 * changes the npm finding.
 */

import type { Advisory, AdvisoryIdentifier, Severity } from '../types.js';
import type { HttpClient } from '../registry/http.js';
import { FetchError, errorForStatus } from '../registry/http.js';
import type { EtagStore } from '../registry/versions.js';

export const GITHUB_ADVISORIES_API = 'https://api.github.com/advisories';
export const GITHUB_API_VERSION = '2022-11-28';
export const GITHUB_IDENTIFIER_BATCH_PAGE_SIZE = 100;
export const MAX_GITHUB_IDENTIFIER_BATCH_PAGES = 10;
export const MAX_GITHUB_IDENTIFIER_BATCH_URL_LENGTH = 7_000;
export const GITHUB_IDENTIFIER_TIMEOUT_MS = 2_500;
export const GITHUB_IDENTIFIER_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

const GHSA_PATTERN = /^GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i;
const CVE_PATTERN = /^CVE-\d{4}-\d{4,}$/i;
const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

function normalizedIdentifier(type: 'CVE' | 'GHSA', value: unknown): AdvisoryIdentifier | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  const valid = type === 'CVE' ? CVE_PATTERN.test(normalized) : GHSA_PATTERN.test(normalized);
  return valid ? { type, value: normalized } : null;
}

function addIdentifier(
  target: AdvisoryIdentifier[],
  seen: Set<string>,
  identifier: AdvisoryIdentifier | null
): void {
  if (identifier === null) return;
  const key = `${identifier.type}:${identifier.value}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push(identifier);
}

/** Only npm-provided links to GitHub's public advisory route can create API requests. */
export function ghsaIdentifierFromAdvisoryUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return null;
  }
  const match = /^\/advisories\/(GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/?$/i.exec(parsed.pathname);
  return match?.[1]?.toUpperCase() ?? null;
}

function parseGitHubAdvisoryIdentifiers(
  body: string,
  expectedGhsa: string,
  url: string
): AdvisoryIdentifier[] {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new FetchError('PARSE_ERROR', `invalid JSON from ${url}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new FetchError('PARSE_ERROR', `unexpected JSON shape from ${url}`);
  }
  const record = raw as Record<string, unknown>;
  const responseGhsa = normalizedIdentifier('GHSA', record['ghsa_id']);
  if (responseGhsa?.value !== expectedGhsa) {
    throw new FetchError('PARSE_ERROR', `GitHub advisory identifier mismatch from ${url}`);
  }

  const identifiers: AdvisoryIdentifier[] = [];
  const seen = new Set<string>();
  addIdentifier(identifiers, seen, normalizedIdentifier('GHSA', expectedGhsa));
  addIdentifier(identifiers, seen, normalizedIdentifier('CVE', record['cve_id']));

  const rawIdentifiers = record['identifiers'];
  if (Array.isArray(rawIdentifiers)) {
    for (const rawIdentifier of rawIdentifiers.slice(0, 16)) {
      if (typeof rawIdentifier !== 'object' || rawIdentifier === null || Array.isArray(rawIdentifier)) continue;
      const candidate = rawIdentifier as Record<string, unknown>;
      if (candidate['type'] === 'CVE') {
        addIdentifier(identifiers, seen, normalizedIdentifier('CVE', candidate['value']));
      } else if (candidate['type'] === 'GHSA') {
        const candidateGhsa = normalizedIdentifier('GHSA', candidate['value']);
        if (candidateGhsa?.value === expectedGhsa) addIdentifier(identifiers, seen, candidateGhsa);
      }
    }
  }

  return identifiers.sort((left, right) => {
    const leftRank = left.type === 'CVE' ? 0 : 1;
    const rightRank = right.type === 'CVE' ? 0 : 1;
    return leftRank - rightRank || left.value.localeCompare(right.value);
  });
}

function cachedIdentifiers(
  store: EtagStore,
  url: string,
  ghsa: string
): { identifiers: AdvisoryIdentifier[]; etag: string; cachedAt: number | null } | null {
  const cached = store.get(url);
  if (cached === undefined) return null;
  try {
    const parsed = JSON.parse(cached.body) as unknown;
    const cachedAt =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)['cached_at'] === 'number'
        ? (parsed as Record<string, unknown>)['cached_at'] as number
        : null;
    return { identifiers: parseGitHubAdvisoryIdentifiers(cached.body, ghsa, url), etag: cached.etag, cachedAt };
  } catch {
    return null;
  }
}

function hasFreshCachedCve(
  cached: { identifiers: AdvisoryIdentifier[]; cachedAt: number | null } | null,
  now: number
): boolean {
  if (cached === null || !cached.identifiers.some((identifier) => identifier.type === 'CVE')) return false;
  if (cached.cachedAt === null || !Number.isFinite(cached.cachedAt)) return false;
  const age = now - cached.cachedAt;
  return age >= 0 && age < GITHUB_IDENTIFIER_CACHE_TTL_MS;
}

function compactCachedBody(
  ghsa: string,
  identifiers: readonly AdvisoryIdentifier[],
  cachedAt: number
): string {
  return JSON.stringify({
    ghsa_id: ghsa,
    cve_id: identifiers.find((identifier) => identifier.type === 'CVE')?.value ?? null,
    identifiers,
    cached_at: cachedAt,
  });
}

/** Fetch one exact GitHub advisory. A cached CVE alias is immutable enough to reuse without another request. */
export async function fetchGitHubAdvisoryIdentifiers(
  client: HttpClient,
  store: EtagStore,
  ghsa: string,
  signal?: AbortSignal
): Promise<AdvisoryIdentifier[]> {
  const normalizedGhsa = normalizedIdentifier('GHSA', ghsa)?.value;
  if (normalizedGhsa === undefined) throw new FetchError('BAD_URL', 'invalid GHSA identifier');

  const url = `${GITHUB_ADVISORIES_API}/${encodeURIComponent(normalizedGhsa)}`;
  const cached = cachedIdentifiers(store, url, normalizedGhsa);
  if (cached !== null && hasFreshCachedCve(cached, Date.now())) {
    return cached.identifiers;
  }

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': 'npm-dependency-dashboard',
  };
  if (cached !== null) headers['if-none-match'] = cached.etag;

  const response = await client.get(url, {
    headers,
    timeoutMs: GITHUB_IDENTIFIER_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.status === 304) {
    if (cached === null) throw new FetchError('NETWORK', `304 for ${url} with nothing cached`);
    store.set(url, {
      etag: cached.etag,
      body: compactCachedBody(normalizedGhsa, cached.identifiers, Date.now()),
    });
    return cached.identifiers;
  }
  if (response.status === 403 && response.headers['x-ratelimit-remaining'] === '0') {
    throw new FetchError('RATE_LIMITED', `rate limited: ${url}`, 403);
  }
  if (response.status !== 200) throw errorForStatus(response.status, url);

  const identifiers = parseGitHubAdvisoryIdentifiers(response.body, normalizedGhsa, url);
  const etag = response.headers['etag'];
  if (etag !== undefined) {
    store.set(url, {
      etag,
      body: compactCachedBody(normalizedGhsa, identifiers, Date.now()),
    });
  }
  return identifiers;
}

function mergeIdentifiers(advisory: Advisory, identifiers: readonly AdvisoryIdentifier[]): Advisory {
  if (identifiers.length === 0) return advisory;
  const merged: AdvisoryIdentifier[] = [];
  const seen = new Set<string>();
  for (const identifier of [...identifiers, ...(advisory.identifiers ?? [])]) {
    addIdentifier(merged, seen, normalizedIdentifier(identifier.type, identifier.value));
  }
  return merged.length === 0 ? advisory : { ...advisory, identifiers: merged };
}

function githubHeaders(): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': 'npm-dependency-dashboard',
  };
}

function batchUrl(packageNames: readonly string[]): string {
  const parameters = new URLSearchParams({
    ecosystem: 'npm',
    affects: packageNames.join(','),
    per_page: String(GITHUB_IDENTIFIER_BATCH_PAGE_SIZE),
  });
  return `${GITHUB_ADVISORIES_API}?${parameters.toString()}`;
}

function batchUrls(packageNames: readonly string[]): string[] {
  const urls: string[] = [];
  let current: string[] = [];
  for (const packageName of packageNames) {
    const candidate = [...current, packageName];
    if (current.length > 0 && batchUrl(candidate).length > MAX_GITHUB_IDENTIFIER_BATCH_URL_LENGTH) {
      urls.push(batchUrl(current));
      current = [packageName];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) urls.push(batchUrl(current));
  return urls;
}

function nextBatchPage(linkHeader: string | undefined): string | null {
  if (linkHeader === undefined) return null;
  for (const part of linkHeader.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="next"\s*$/.exec(part);
    if (match?.[1] === undefined) continue;
    try {
      const next = new URL(match[1]);
      if (
        next.protocol === 'https:' &&
        next.hostname === 'api.github.com' &&
        next.port === '' &&
        next.username === '' &&
        next.password === '' &&
        next.pathname === '/advisories'
      ) {
        return next.toString();
      }
    } catch {
      return null;
    }
  }
  return null;
}

function parseBatchIdentifiers(
  body: string,
  url: string,
  targetGhsas: ReadonlySet<string>
): Map<string, AdvisoryIdentifier[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new FetchError('PARSE_ERROR', `invalid JSON from ${url}`);
  }
  if (!Array.isArray(raw)) throw new FetchError('PARSE_ERROR', `unexpected JSON shape from ${url}`);

  const identifiers = new Map<string, AdvisoryIdentifier[]>();
  for (const record of raw.slice(0, GITHUB_IDENTIFIER_BATCH_PAGE_SIZE)) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
    const ghsa = normalizedIdentifier('GHSA', (record as Record<string, unknown>)['ghsa_id'])?.value;
    if (ghsa === undefined || !targetGhsas.has(ghsa)) continue;
    identifiers.set(ghsa, parseGitHubAdvisoryIdentifiers(JSON.stringify(record), ghsa, url));
  }
  return identifiers;
}

async function fetchBatchIdentifiers(
  client: HttpClient,
  packageNames: readonly string[],
  targetGhsas: ReadonlySet<string>,
  signal?: AbortSignal
): Promise<Map<string, AdvisoryIdentifier[]>> {
  const identifiers = new Map<string, AdvisoryIdentifier[]>();
  let remainingPages = MAX_GITHUB_IDENTIFIER_BATCH_PAGES;

  for (const initialUrl of batchUrls(packageNames)) {
    let url: string | null = initialUrl;
    while (url !== null && remainingPages > 0) {
      remainingPages -= 1;
      try {
        const response = await client.get(url, {
          headers: githubHeaders(),
          timeoutMs: GITHUB_IDENTIFIER_TIMEOUT_MS,
          ...(signal === undefined ? {} : { signal }),
        });
        if (response.status === 403 && response.headers['x-ratelimit-remaining'] === '0') {
          throw new FetchError('RATE_LIMITED', `rate limited: ${url}`, 403);
        }
        if (response.status !== 200) throw errorForStatus(response.status, url);
        for (const [ghsa, values] of parseBatchIdentifiers(response.body, url, targetGhsas)) {
          identifiers.set(ghsa, values);
        }
        if (identifiers.size === targetGhsas.size) return identifiers;
        url = nextBatchPage(response.headers['link']);
      } catch (cause) {
        if (cause instanceof FetchError && cause.code === 'CANCELLED') throw cause;
        // Identifier enrichment is optional and paginated. A later page must
        // never erase exact GHSA/CVE pairs already validated from an earlier
        // page merely because that best-effort continuation timed out or was
        // rate-limited. Stop this page chain and return the verified subset.
        url = null;
      }
    }
    if (remainingPages === 0) break;
  }
  return identifiers;
}

/**
 * Enrich unique npm advisories through GitHub's documented `affects` batch
 * filter. This avoids one unauthenticated API request per GHSA (and its
 * 60-request hourly ceiling) while still attaching identifiers only when the
 * returned GHSA exactly matches an npm-issued advisory. Missing GitHub data
 * always returns the original map.
 */
export async function enrichAdvisoriesWithGitHubIdentifiers(
  client: HttpClient,
  store: EtagStore,
  advisoriesByName: ReadonlyMap<string, readonly Advisory[]>,
  signal?: AbortSignal
): Promise<Map<string, Advisory[]>> {
  const byGhsa = new Map<string, Advisory>();
  for (const advisories of advisoriesByName.values()) {
    for (const advisory of advisories) {
      const ghsa = ghsaIdentifierFromAdvisoryUrl(advisory.url);
      if (ghsa !== null && !byGhsa.has(ghsa)) byGhsa.set(ghsa, advisory);
    }
  }
  if (byGhsa.size === 0) {
    return new Map([...advisoriesByName].map(([name, advisories]) => [name, [...advisories]]));
  }

  const allEntries = [...byGhsa].sort((left, right) =>
    SEVERITY_RANK[right[1].severity] - SEVERITY_RANK[left[1].severity] || left[0].localeCompare(right[0])
  );
  const cachedByGhsa = new Map<string, AdvisoryIdentifier[]>();
  const missingGhsas = new Set<string>();
  for (const entry of allEntries) {
    const [ghsa] = entry;
    const url = `${GITHUB_ADVISORIES_API}/${encodeURIComponent(ghsa)}`;
    const cached = cachedIdentifiers(store, url, ghsa);
    if (cached !== null && hasFreshCachedCve(cached, Date.now())) {
      cachedByGhsa.set(ghsa, cached.identifiers);
    } else {
      missingGhsas.add(ghsa);
    }
  }

  const identifiersByGhsa = new Map(cachedByGhsa);
  if (missingGhsas.size > 0) {
    const packageNames = [...advisoriesByName]
      .filter(([, advisories]) => advisories.some((advisory) => {
        const ghsa = ghsaIdentifierFromAdvisoryUrl(advisory.url);
        return ghsa !== null && missingGhsas.has(ghsa);
      }))
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right));
    try {
      const fetched = await fetchBatchIdentifiers(client, packageNames, missingGhsas, signal);
      for (const [ghsa, identifiers] of fetched) {
        identifiersByGhsa.set(ghsa, identifiers);
        store.set(`${GITHUB_ADVISORIES_API}/${encodeURIComponent(ghsa)}`, {
          etag: '',
          body: compactCachedBody(ghsa, identifiers, Date.now()),
        });
      }
    } catch (cause) {
      if (cause instanceof FetchError && cause.code === 'CANCELLED') throw cause;
    }
  }

  const enriched = new Map<string, Advisory[]>();
  for (const [name, advisories] of advisoriesByName) {
    enriched.set(name, advisories.map((advisory) => {
      const ghsa = ghsaIdentifierFromAdvisoryUrl(advisory.url);
      return ghsa === null ? advisory : mergeIdentifiers(advisory, identifiersByGhsa.get(ghsa) ?? []);
    }));
  }
  return enriched;
}
