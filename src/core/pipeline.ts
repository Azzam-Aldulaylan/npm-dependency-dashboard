/**
 * The composition root for the table's data.
 *
 * Chains S1 (manifest + lockfile graph), S2 (hybrid version fetching) and
 * S3/S3b (bulk advisories, attribution, severity, fixAvailable) into
 * PackageRow[]. Each stage is already written to fail per-item rather than
 * per-batch; this file's job is to keep that property end to end, so that a
 * dead registry, an unreachable npm, or a single 404 degrades one column
 * instead of emptying the table.
 *
 * Nothing here may import 'vscode' — see types.ts.
 */

import type { AuditRunner } from './audit/npmAudit.js';
import { runNpmAudit, mapFixAvailableToDirectDependencies } from './audit/npmAudit.js';
import { worstSeverity, resolveUpgradeTarget } from './advisories/aggregate.js';
import { attributeAdvisories } from './advisories/attribution.js';
import { buildBulkRequestBody, fetchBulkAdvisories } from './advisories/bulk.js';
import { directNodes } from './lockfile/parse.js';
import { buildDependencyGraph } from './lockfile/build.js';
import { parseManifest } from './manifest/parse.js';
import type { HttpClient } from './registry/http.js';
import { FetchError } from './registry/http.js';
import type { EtagStore, VersionRequest } from './registry/versions.js';
import { fetchAllVersions, fetchPackument } from './registry/versions.js';
import type { Advisory, AttributedAdvisory, FixAvailable, PackageRow, VersionInfo } from './types.js';
import type { PackageManagerKind } from './types.js';

export interface BuildPackageRowsOptions {
  /** Absolute path to the directory holding package.json. */
  root: string;
  manifestText: string;
  /** Raw lockfile text, or null when no lockfile exists. */
  lockfileText: string | null;
  packageManager?: PackageManagerKind;
  importerId?: string;
  /** Resolved from .npmrc — version data only. Advisories always go to npm. */
  registry: string;
  httpClient: HttpClient;
  etagStore: EtagStore;
  /** Omit entirely to skip the optional `npm audit` enrichment. */
  auditRunner?: AuditRunner;
  concurrency?: number;
  signal?: AbortSignal;
}

export interface BuildPackageRowsResult {
  rows: PackageRow[];
  /** Set when the bulk fetch failed outright; rows are still returned, without advisory data. */
  advisoriesError?: FetchError;
  /** True when no runner was given, or audit failed / returned unparseable output. */
  auditUnavailable?: boolean;
}

/**
 * Cancellation is not a degraded-data case like a dead registry or missing
 * npm — it means the caller no longer wants a result at all. Every other
 * failure here is swallowed into `advisoriesError`/`auditUnavailable` so rows
 * still render; an abort instead stops the whole call, checked at each stage
 * boundary so a signal firing mid-run doesn't let later stages keep going and
 * hand back rows built from a mix of fresh and abandoned work.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new FetchError('CANCELLED', 'buildPackageRows was aborted');
  }
}

export async function buildPackageRows(
  options: BuildPackageRowsOptions
): Promise<BuildPackageRowsResult> {
  const { root, manifestText, lockfileText, registry, httpClient, etagStore, signal } = options;
  throwIfAborted(signal);

  const manifest = parseManifest(manifestText);
  const graph = buildDependencyGraph({
    root,
    manifest,
    lockfileText,
    packageManager: options.packageManager ?? 'npm',
    ...(options.importerId === undefined ? {} : { importerId: options.importerId }),
  });
  const roots = directNodes(graph);

  // --- versions -------------------------------------------------------
  // Unresolvable nodes (workspace links, file:/git: specifiers, no lockfile)
  // have no registry entry; asking would be a guaranteed 404 presented to the
  // user as an error on a perfectly healthy dependency.
  const requests: VersionRequest[] = roots
    .filter((n) => n.unresolvable === undefined)
    .map((n) => ({ name: n.name, range: n.range, installed: n.version }));

  const fetchOptions: Parameters<typeof fetchAllVersions>[0] = {
    client: httpClient,
    store: etagStore,
    registry,
  };
  if (options.concurrency !== undefined) fetchOptions.limit = options.concurrency;
  if (signal !== undefined) fetchOptions.signal = signal;

  const settled = await fetchAllVersions(fetchOptions, requests);
  const versionsByName = new Map<string, VersionInfo>();
  requests.forEach((req, i) => {
    const result = settled[i];
    // A per-package failure is simply an absent entry — that row renders with
    // null wanted/latest and doesn't disturb any other row.
    if (result?.ok === true) versionsByName.set(req.name, result.value);
  });
  throwIfAborted(signal);

  // --- advisories -----------------------------------------------------
  let advisoriesByName = new Map<string, Advisory[]>();
  let advisoriesError: FetchError | undefined;
  try {
    advisoriesByName = await fetchBulkAdvisories(httpClient, buildBulkRequestBody(graph), signal);
  } catch (cause) {
    advisoriesError =
      cause instanceof FetchError
        ? cause
        : new FetchError('NETWORK', cause instanceof Error ? cause.message : String(cause));
  }
  throwIfAborted(signal);

  const attributed = attributeAdvisories(graph, advisoriesByName);

  // --- audit enrichment (optional) -------------------------------------
  let fixes = new Map<string, FixAvailable>();
  let auditUnavailable = false;
  if (options.auditRunner === undefined) {
    auditUnavailable = true;
  } else {
    try {
      const vulnerabilities = await runNpmAudit(options.auditRunner, root, signal);
      fixes = mapFixAvailableToDirectDependencies(
        vulnerabilities,
        new Set(roots.map((n) => n.name))
      );
    } catch {
      // Enrichment only. Every failure mode — npm missing, ENOLOCK, garbage on
      // stdout — degrades to the self-computed fallback below.
      auditUnavailable = true;
    }
  }
  throwIfAborted(signal);

  // --- packument escalation, only where the fallback will use it --------
  // S2's whole design is to avoid fetching the packument for every package
  // (31x the wire bytes, 54x the parse cost). The self-computed fallback needs
  // the full version list, but only for a direct dependency that is itself
  // flagged AND has no usable fixAvailable — usually a handful of packages,
  // and none at all when audit is healthy.
  const availableVersions = new Map<string, string[]>();
  for (const node of roots) {
    if (node.unresolvable !== undefined) continue;
    const own = attributed.get(node.name)?.some((a) => a.path.length === 1) ?? false;
    const fix = fixes.get(node.name);
    // An object names an explicit version and `false` says no fix exists, so
    // neither needs a version-list lookup. Boolean `true` names no version;
    // verify a clean candidate ourselves just as we do when audit is absent.
    const needsSelfComputedFix = fix === undefined || fix === true;
    if (!own || !needsSelfComputedFix) continue;
    // Checked per iteration, not just once before the loop: this can run over
    // several packages, and a signal firing partway through should stop it
    // before the remaining ones are fetched too.
    throwIfAborted(signal);
    try {
      const packument = await fetchPackument(httpClient, etagStore, registry, node.name, signal);
      availableVersions.set(node.name, packument.versions);
    } catch {
      // resolveUpgradeTarget simply finds nothing to offer with an empty list,
      // which is the right answer when we can't see the version history.
      availableVersions.set(node.name, []);
    }
  }
  throwIfAborted(signal);

  // --- rows ------------------------------------------------------------
  const rows: PackageRow[] = roots.map((node) => {
    const info = versionsByName.get(node.name);
    const advisories: AttributedAdvisory[] = attributed.get(node.name) ?? [];
    const fixAvailable = fixes.get(node.name);

    const row: PackageRow = {
      name: node.name,
      current: node.version,
      wanted: info?.wanted ?? null,
      latest: info?.latest ?? null,
      dev: node.dev,
      range: node.range,
      advisories,
      worstSeverity: worstSeverity(advisories),
      upgradeTo: resolveUpgradeTarget({
        installed: node.version,
        range: node.range,
        availableVersions: availableVersions.get(node.name) ?? [],
        advisories,
        ...(fixAvailable === undefined ? {} : { fixAvailable }),
      }),
    };
    if (info?.deprecated !== undefined) row.deprecated = info.deprecated;
    if (node.unresolvable !== undefined) row.unresolvable = node.unresolvable;
    return row;
  });

  const result: BuildPackageRowsResult = { rows };
  if (advisoriesError !== undefined) result.advisoriesError = advisoriesError;
  if (auditUnavailable) result.auditUnavailable = true;
  return result;
}
