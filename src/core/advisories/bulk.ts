/**
 * POST /-/npm/v1/security/advisories/bulk — the primary vulnerability source.
 *
 * Measured against `npm audit --json` on a 200-package tree (34 findings):
 * 348ms / 4,482B request / 37,149B response here, vs. 1,584ms / 76,139B
 * stdout for audit, for an identical advisory set (32/32 match — audit's
 * extra two "findings" are blame-graph nodes with no advisory of their own).
 * See docs/npm-dashboard-extension-spec.md, Vulnerability Scope.
 *
 * This targets npm's own advisory host explicitly, regardless of the
 * resolved `.npmrc` registry — private mirrors generally don't implement
 * this endpoint, and `npm audit` would otherwise silently POST the
 * dependency tree wherever the project `.npmrc` points.
 *
 * Verified live against the real endpoint: a queried package with no
 * advisories is simply absent from the response (not an empty array), the
 * request requires `Content-Type: application/json` (400 without it), and an
 * empty `{}` request body is answered with an empty `{}` — all handled below.
 */

import type { HttpClient } from '../registry/http.js';
import { FetchError, errorForStatus } from '../registry/http.js';
import type { Advisory, DependencyGraph, Severity } from '../types.js';

export const ADVISORIES_HOST = 'https://registry.npmjs.org';
export const ADVISORIES_PATH = '/-/npm/v1/security/advisories/bulk';

const SEVERITIES: ReadonlySet<string> = new Set<Severity>([
  'critical',
  'high',
  'moderate',
  'low',
  'info',
]);

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && SEVERITIES.has(value);
}

function parseAdvisory(raw: unknown): Advisory | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const id = r['id'];
  const url = r['url'];
  const title = r['title'];
  const vulnerableVersions = r['vulnerable_versions'];
  const severity = r['severity'];

  if (
    (typeof id !== 'number' && typeof id !== 'string') ||
    typeof url !== 'string' ||
    typeof title !== 'string' ||
    typeof vulnerableVersions !== 'string' ||
    !isSeverity(severity)
  ) {
    return null;
  }

  return { id, severity, title, url, vulnerableVersions };
}

/**
 * Every (name, resolved version) pair present anywhere in the tree — the
 * bulk endpoint's request shape, same set `npm audit` would submit.
 * Unresolvable nodes (workspace links, `file:`/`git:` specifiers, no
 * lockfile) carry no version and are excluded; there is nothing to look up.
 */
export function buildBulkRequestBody(graph: DependencyGraph): Record<string, string[]> {
  const byName = new Map<string, Set<string>>();

  for (const node of graph.nodes.values()) {
    if (node.version === null) continue;
    const versions = byName.get(node.name) ?? new Set<string>();
    versions.add(node.version);
    byName.set(node.name, versions);
  }

  const body: Record<string, string[]> = {};
  for (const [name, versions] of byName) {
    body[name] = [...versions];
  }
  return body;
}

/**
 * Call the bulk endpoint and return advisories keyed by package name.
 *
 * A name absent from the result has no known advisories — the endpoint
 * omits clean packages entirely rather than returning an empty array.
 */
export async function fetchBulkAdvisories(
  client: HttpClient,
  requestBody: Record<string, string[]>,
  signal?: AbortSignal
): Promise<Map<string, Advisory[]>> {
  if (Object.keys(requestBody).length === 0) return new Map();

  const url = `${ADVISORIES_HOST}${ADVISORIES_PATH}`;
  const body = JSON.stringify(requestBody);
  const options = {
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  };

  const response = await client.post(url, body, options);
  if (response.status !== 200) throw errorForStatus(response.status, url);

  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    throw new FetchError('PARSE_ERROR', `invalid JSON from ${url}`);
  }
  if (typeof json !== 'object' || json === null) {
    throw new FetchError('PARSE_ERROR', `unexpected JSON shape from ${url}`);
  }

  const result = new Map<string, Advisory[]>();
  for (const [name, rawList] of Object.entries(json as Record<string, unknown>)) {
    if (name === '__proto__' || !Array.isArray(rawList)) continue;
    const advisories = rawList.map(parseAdvisory).filter((a): a is Advisory => a !== null);
    if (advisories.length > 0) result.set(name, advisories);
  }
  return result;
}
