# Dependency Dashboard performance report

Measured on 2026-08-18 from baseline commit `67387b1f6355b960130f37a3aa457eded442ccee` on the dedicated `perf/dependency-dashboard` branch. The deterministic benchmark runs locally with fixture-backed HTTP adapters. Its latency numbers are **not npm-registry measurements**.

## Baseline

Before implementation changes:

- `npm run typecheck`: passed.
- `npm test`: 833/833 passed; 0 failures; 1,734.96 ms reported by Node's test runner.
- `npm run build`: passed (extension 459.1 KiB, webview 1.3 MiB development bundles; 79/93 ms).
- `npm run package`: passed (VSIX 165.23 KiB).
- Branch/head at measurement: integration source at `67387b1f6355b960130f37a3aa457eded442ccee`, before the performance branch had new commits.

The benchmark uses npm lockfile v3 fixtures with these shapes:

| Fixture | Direct dependencies | Graph nodes | Flagged packages |
| --- | ---: | ---: | ---: |
| Small | 15 | 45 | 3 |
| Medium | 50 | 250 | 10 |
| Large | 125 | 1,125 | 25 |

Baseline measurements:

| Scenario | Small | Medium | Large |
| --- | ---: | ---: | ---: |
| CPU/local processing, zero-latency adapters (median of 7) | 0.9 ms | 2.6 ms | 17.5 ms |
| Controlled latency, 8 ms `/latest`, 20 ms packument, 30 ms advisories, 50 ms audit (median of 3) | 228.2 ms | 570.2 ms | 1,307.6 ms |
| `/latest` requests | 15 | 50 | 125 |
| Packument requests | 6 | 20 | 50 |
| Peak patched-packument concurrency | 1 | 1 | 1 |

The zero-latency results show that local manifest/graph/row CPU is not the dominant startup cost at these sizes. The controlled-latency result isolates request scheduling and duplicated work as the primary issue.

## Current pipeline trace

Dashboard startup follows this path:

```text
VS Code activation (register commands only)
  -> DashboardPanel.createOrShow
  -> project discovery
  -> manifest read + parse
  -> lockfile discovery + read
  -> npm/pnpm lockfile parse
  -> normalized dependency graph
  -> hybrid version resolution (/latest, packument only when required)
  -> bulk advisory request
  -> graph advisory attribution
  -> flagged-package patched-version resolution
  -> optional npm audit fixAvailable enrichment
  -> remediation fallback
  -> PackageRow + hygiene finding composition
  -> persisted cache write
  -> host/webview serialization
  -> React filter -> search -> sort -> paginate -> current-page render
```

Activation does not start dependency analysis. Project and registry work begins only after the dashboard command opens the panel.

The following flows remain explicitly on demand and are not part of dashboard startup:

- Upgrade Preflight and Smart Upgrade Planning: the upgrade assistant coordinator resolves package-manager details, compatibility metadata, and a plan only after an upgrade request.
- Resolver verification: runs only in upgrade/remediation analysis or execution.
- Where Is This Used?: invokes the usage coordinator for one package.
- Analyze Cleanup: invokes one shared workspace usage scan for all direct dependencies.
- Why Is This Installed?: reads the already-normalized graph/row context and does not trigger a dashboard rescan.

## Instrumentation

`dependencyDashboard.debug.performance` enables structured, local-only diagnostic output in the extension host and webview developer consoles. It defaults to `false`; when disabled, stage starts do not read the clock or allocate measurement objects. The output contains operation names, durations, counts, status names, and serialized byte counts. It never logs registry credentials, headers, `.npmrc` contents, tokens, or environment values.

Measured stages include:

- activation, discovery, manifest read/parse, lockfile discovery/read/parse, and graph construction;
- version metadata, bulk advisory request, advisory attribution, patched-version metadata, npm audit, and row composition;
- cache read, fingerprint validation, freshness classification, and cache write;
- webview message serialization and initial two-animation-frame render;
- usage file discovery, source scan, config scan, and usage-cache lookup.

Scan metadata includes direct dependencies, graph nodes, registry requests, `/latest` requests, packument requests, ETag hits, 304 responses, advisory packages, package-manager subprocesses, and scan-local packument reuse. Instrumentation is diagnostic logging, not telemetry.

## Bottlenecks and priority

### P1 — serial patched-version packuments

**Operation:** Vulnerability patched-version metadata.

**Evidence:** Code inspection found an awaited packument fetch inside a `for` loop. The controlled large fixture made 25 first-stage packument requests at peak concurrency 1 and contributed to a 1,307.6 ms total.

**Impact:** Latency grew approximately linearly with the number of flagged packages, which is especially visible on security-heavy projects and corporate registries/proxies.

**Root cause:** The version request pool was not reused for remediation metadata.

### P1 — duplicate packuments within one scan

**Operation:** Patched-version calculation followed by self-computed remediation fallback.

**Evidence:** The baseline made two packument requests for each flagged direct dependency: 6/20/50 requests for 3/10/25 flagged packages. The second request could receive a 304 through the persisted ETag cache, but it still incurred a network round trip.

**Impact:** Doubled full-metadata request count for the affected packages and added proxy/registry latency without adding information.

**Root cause:** Independent stages called `fetchPackument` without a scan-scoped promise cache.

### P1 — npm audit unnecessarily serialized after registry work

**Operation:** Optional `npm audit` enrichment.

**Evidence:** Pipeline trace showed audit was started only after versions, bulk advisories, attribution, and patched metadata. In the controlled fixture it independently costs about 50 ms.

**Impact:** Its subprocess latency was added to the critical path even though its input is available after graph construction.

**Root cause:** Sequential orchestration, not a data dependency.

`npm audit` was not removed. Bulk advisories establish vulnerability records and paths; audit uniquely contributes npm's `fixAvailable` guidance. The scan still waits for that enrichment before final row composition so no existing row information is lost.

### P2 — pnpm missing-direct-node check traversed the graph repeatedly

**Operation:** pnpm normalized graph construction.

**Evidence:** The builder spread and searched all nodes once for every direct dependency when checking whether a direct node was missing.

**Impact:** Avoidable `O(direct dependencies × graph nodes)` work on large pnpm workspaces.

**Root cause:** Direct names were not tracked while the graph was built.

### P2 — usage-analysis cache age was invisible

**Operation:** Where Used and cleanup-result presentation.

**Evidence:** Results use a source fingerprint and ten-minute TTL but the UI did not disclose the scan time or provide an explicit cache bypass.

**Impact:** A cached result could look newly authoritative even though source files are intentionally not watched continuously.

**Root cause:** Cache metadata stopped at the host boundary.

### P3 / no implementation needed — table CPU

**Operation:** Summary computation, filter, search, sort, pagination.

**Evidence:** The optimized-build local benchmark processes 150 rows in 0.6 ms median over 1,000 iterations and returns only 25 current-page rows.

**Impact:** Not material compared with network and subprocess stages.

**Root cause:** None. The existing order is already filter -> search -> sort -> paginate -> render, so all rows are not rendered and hidden with CSS.

## Changes

### Bounded patched-version resolution

**Optimization:** Fetch distinct flagged-package packuments through the existing cancellation-aware `runPool`, using the configured scan concurrency (default 8).

**Why:** Removes the measured serial tail without adding unbounded `Promise.all` pressure.

**Risk:** Higher instantaneous registry activity for flagged packages.

**Controls/tests:** Existing bound is retained; cancellation propagates; settlement isolates one bad package; tests assert peak concurrency, batch survival, and cancellation.

### Scan-local packument promise cache

**Optimization:** Share one `Map<package, Promise<packument>>` across hybrid Wanted/Latest escalation, patched-version calculation, and remediation fallback.

**Why:** A fulfilled or failed lookup is reused throughout one logical scan, while the persisted ETag store continues to govern cross-scan revalidation.

**Risk:** Accidentally sharing metadata across projects or scans.

**Controls/tests:** The map is created inside `buildPackageRows`, so it cannot cross a project/scan boundary. Tests assert exactly one packument fetch per package in a scan.

### Overlap optional npm audit

**Optimization:** Start npm audit once the graph provides the trusted direct-dependency allow-list, while registry stages continue; await it before row composition.

**Why:** Hides independent subprocess latency without dropping `fixAvailable` data.

**Risk:** Cancellation or audit failure could affect unrelated registry work.

**Controls/tests:** Audit remains optional and failure-isolated; cancellation is passed through; tests assert overlap and cancellation behavior.

### pnpm direct-name set

**Optimization:** Track direct names during graph construction and use constant-time membership checks when synthesizing missing direct nodes.

**Why:** Removes repeated whole-graph searches without changing graph semantics.

**Risk:** A branch could fail to add a direct name.

**Controls/tests:** Existing npm/pnpm/workspace graph suite covers resolved, unresolved, linked, and drifted direct dependencies.

### Shared usage reference index and cache UX

**Optimization:** Parse each relevant source file once, bucket all requested dependency references into a shared index, and answer cleanup for every package from that index. Pass analysis/cache expiry timestamps to the webview and add subtle age/stale text plus `Re-analyze` controls for both Where Used and cleanup.

**Why:** Prevents an accidental dependency-count multiplier and makes the existing ten-minute cache policy visible.

**Risk:** Reference attribution could leak between package buckets; protocol additions could weaken the host/webview boundary.

**Controls/tests:** Tests inject a counting scanner and assert one parse per file for all dependencies and isolated package results. Protocol validators remain closed-shape and validate all added messages/fields. Re-analysis sends only a package name; the host still derives the project and trusted file scope.

### Real loading progress

**Optimization:** Send stage names and actual request settlement counts to the existing loading view.

**Why:** Gives useful perceived-progress feedback during cold/manual scans without fabricated percentages or UI redesign.

**Risk:** Protocol churn and misleading progress during concurrent work.

**Controls/tests:** Counts are emitted only from settled pool items; stage-only messages are used where no meaningful denominator exists; strict protocol tests reject unknown stages and inconsistent counts.

## Before / after

Final deterministic benchmark:

| Scenario | Small | Medium | Large |
| --- | ---: | ---: | ---: |
| CPU/local before | 0.9 ms | 2.6 ms | 17.5 ms |
| CPU/local after | 0.8 ms | 2.5 ms | 17.6 ms |
| Controlled latency before | 228.2 ms | 570.2 ms | 1,307.6 ms |
| Controlled latency after | 74.7 ms | 149.5 ms | 291.4 ms |
| Packuments before -> after | 6 -> 3 | 20 -> 10 | 50 -> 25 |
| Peak packument concurrency before -> after | 1 -> 3 | 1 -> 8 | 1 -> 8 |

Large-fixture reduction: 1,307.6 ms -> 291.4 ms (1,016.2 ms, 77.7%). This is a controlled adapter result; real improvement depends on registry/proxy latency and the number of vulnerabilities.

After-stage medians for the large controlled fixture:

| Stage | Duration |
| --- | ---: |
| Version metadata | 148.4 ms |
| Bulk advisories | 32.7 ms |
| Patched versions | 86.2 ms |
| npm audit | 50.4 ms (overlapped) |

The CPU/local result is intentionally almost unchanged. The improvement comes from request reuse, bounded scheduling, and overlapping independent work rather than benchmark-only computation tricks.

Additional local CPU measurements:

- Webview pure data path, 150 rows: 0.6 ms median; page output is 25 rows.
- Usage reference index, 125 dependency names across 1,000 fixture source files: 0.6 ms median; exactly one injected parser call per source file per run.

Run the reproducible suite with `npm run benchmark:performance`.

## Cache behavior

- **Cold open:** no matching cache posts `loading`, then performs one scan. Stage/count progress is now visible.
- **Warm open / panel reopen:** a fresh persisted snapshot with the same source fingerprint renders immediately and skips network validation.
- **Stale cache:** renders stale rows immediately, disables upgrade eligibility, and revalidates in the background.
- **Manual refresh:** deliberately clears the in-memory snapshot and performs a real scan; ETag state may still produce safe 304 reuse.
- **File-change refresh:** source invalidation deletes the persisted snapshot. A 300 ms debounce coalesces manifest/lockfile write bursts; generation checks and aborts suppress stale/overlapping results.
- **Fingerprinting:** manifest, lockfile, manager, importer, and lockfile identity remain part of cache validity. No invalidation rule was weakened.
- **Usage cache:** remains separate, on demand, source-fingerprinted, and limited to ten minutes; the UI now exposes age, cache provenance, stale state, and explicit re-analysis.

The Extension Host GUI was not exercised in this environment, so no real cold/warm npm-registry timing is claimed. The new instrumentation is the mechanism for collecting those numbers on a real project without telemetry.

## Other investigations

- **Registry strategy:** `/<package>/latest` remains the default. Full packuments are still escalated only when ranges, prereleases, deprecation metadata, patched versions, or fallback remediation require them.
- **Version/advisory overlap:** not implemented. Both use HTTP capacity, and the current pools do not share a global per-host limiter; blind overlap could double registry/proxy pressure.
- **Progressive full rows:** not implemented. Basic-row streaming would require partial-row protocol types, cache rules for incomplete snapshots, stable sort/filter behavior while values change, stale generation suppression, and multiple render states. Real stage/count progress gives a low-risk perceived-performance improvement now.
- **Audit-after-render:** not implemented. It could improve first-row visibility, but current rows incorporate audit `fixAvailable`; a second security-result revision would require cache/protocol/state changes. Audit latency is overlapped instead.
- **Parsed graph caching:** not implemented. Zero-latency large-fixture local work is only about 18 ms, while a parsed graph cache adds memory and fingerprint-lifetime complexity.
- **Manifest parsing:** project resolution parses the manifest for manager/workspace decisions and the core pipeline parses it again for dependency rows. This was observed but left unchanged: the measured local budget is already small, and removing it would widen the host/core API for a micro-optimization. The lockfile itself is read once and parsed once per scan.
- **Worker threads:** not justified by the measured local CPU cost.
- **React-wide memoization:** not justified by the 0.6 ms pure 150-row data path. Existing targeted memos and current-page rendering are retained.
- **Package-manager probe caching:** not added. Resolver verification stays on demand, and probing again immediately before mutation preserves executable/version freshness at a security-sensitive boundary.
- **Preflight metadata:** remains lazy. Already-fetched scan packuments are reused only within that scan; no stale cross-project assumption was introduced.

## Performance targets from the evidence

- Keep warm, fingerprint-valid dashboard opens cache-only and near immediate.
- Keep large-fixture local graph/row CPU under 25 ms on the benchmark machine.
- Keep the 125-direct controlled-latency fixture below 400 ms with the documented adapter latencies and concurrency of 8.
- Keep table filter/search/sort/paginate under 5 ms for 150 rows and render no more than the selected page size.
- Keep usage analysis on demand, cancellable, and one source parse per file regardless of direct-dependency count.
- Preserve one full packument request per package per logical scan unless revalidation semantics explicitly require another.

These are regression targets for the deterministic suite, not universal promises for real registries or workspaces.

## Validation coverage

Performance-specific regression coverage includes:

- instrumentation disabled-path overhead and structured measurements;
- one packument fetch per package per scan;
- bounded patched-packument concurrency;
- mid-scan cancellation;
- one failed registry package does not fail the batch;
- npm audit overlap and failure isolation;
- usage cleanup parses each source once, not once per dependency;
- usage bucket isolation;
- strict scan-progress and re-analysis protocol validation.

Existing coverage continues to verify ETag/304 reuse, source-fingerprint invalidation, fresh/stale/manual cache behavior, refresh burst coalescing, no concurrent reloads, stale generation suppression, pagination, sorting, filters, npm/pnpm/workspaces, security attribution, upgrade/preflight/rollback/verification, Workspace Trust, and host/webview boundaries.

## Deferred opportunities

1. Collect real Extension Host traces for cold npm, cold pnpm, warm cache, manual refresh, and corporate proxy scenarios using the new debug switch.
2. Introduce a shared per-registry HTTP scheduler before considering overlap between version metadata and bulk advisories.
3. Prototype audit-after-first-render only with an explicit partial-security-result protocol and cache model.
4. Prototype progressive rows only if real traces show loading feedback is insufficient and the state/correctness cost is justified.
5. Revisit parsed graph caching only if real pnpm workspace traces show local parsing/building, rather than network, is material.
