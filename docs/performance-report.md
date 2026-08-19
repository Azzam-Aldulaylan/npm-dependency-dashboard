# Dependency Dashboard performance report

Measured on 2026-08-19 for the dedicated `perf/dependency-dashboard` pass based on source commit `356205ecafda63408448882bd81e3f871cd7fb65` (`feat/bulk-dependency-actions`). The baseline was captured before changing performance behavior.

## Environment

- Node: `v22.23.2`
- npm: `10.9.8`
- OS: macOS 26.6.1, Darwin 25.6.0, Apple Silicon (`arm64`)
- Package managers exercised deterministically: npm lockfile v3 and pnpm lockfile v9
- Deterministic fixture sizes: 15/45, 50/250, 125/1,125, and 150/1,350 direct dependencies/graph nodes
- Vulnerability fixtures: one flagged package per five direct dependencies (3, 10, 25, and 30)
- Mock network: 8 ms `/latest`, 20 ms packument, 30 ms bulk advisory, 50 ms npm audit
- Real network observation: one live npm bulk-advisory POST; this is not a representative 150-package registry benchmark
- Extension Development Host GUI: unavailable, so no visual or real-project cold/warm timing is claimed

## Baseline validation

Untouched source branch/head: `feat/bulk-dependency-actions` at `356205ecafda63408448882bd81e3f871cd7fb65`.

| Command | Baseline result | Wall time |
| --- | --- | ---: |
| `npm run typecheck` | passed | 3.75 s |
| `npm test` | 905/905 passed | 5.60 s (Node test duration 1,864.25 ms) |
| `npm run build` | passed | 0.49 s |
| `npm run package` | passed, 178.48 KB VSIX | 2.67 s |

Baseline deterministic scan:

| Fixture | Local CPU | Controlled wall clock | `/latest` | Packuments | Bulk POST | Audit processes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 15 direct / 45 nodes | 0.7 ms | 70.5 ms | 15 | 3 | 1 | 1 |
| 50 direct / 250 nodes | 2.5 ms | 140.6 ms | 50 | 10 | 1 | 1 |
| 125 direct / 1,125 nodes | 16.9 ms | 279.0 ms | 125 | 25 | 1 | 1 |

The source benchmark did not yet include the 150-direct case; it was added during this pass rather than fabricating a baseline value.

## Dashboard behavior and time to useful content

The controlled 150-direct delivery model after the changes measured:

| Flow | Time to useful table | Full completion | Message sequence |
| --- | ---: | ---: | --- |
| Cold dashboard | 284.5 ms | 284.5 ms | `loading -> ready` |
| Warm/panel reopen, fresh persisted cache | 0.3 ms | 0.3 ms; no network run | `ready` |
| Manual refresh, old blocking behavior | 276.8 ms | 276.8 ms | `loading -> ready` |
| Manual refresh, table-preserving behavior | 3.8 ms | 300.2 ms | `stale -> ready` |
| File-change refresh | immediate existing table | background scan | `stale -> ready` |

The two manual full-scan numbers are single controlled runs and include timer jitter; this change targets time to useful content, not scan computation. It preserves the last authoritative table, labels it stale/refreshing, revokes upgrade eligibility immediately, and still forces a full disk read and scan. A project switch continues to clear the old project's rows.

Cold time to useful content still equals full-scan completion because partial rows are not streamed. Warm display is already cache-first and does not wait on registry work when the persisted entry is fresh and fingerprint-valid.

## Execution timeline

The complete path is:

```text
Extension activation (command registration only)
  -> project discovery
  -> package.json read + parse
  -> lockfile discovery + read
  -> npm JSON / pnpm YAML parse
  -> normalized graph construction
  -> registry configuration resolution
  -> start npm audit
  -> start version metadata and bulk advisories concurrently
  -> advisory attribution
  -> patched-version metadata
  -> wait for npm audit only if it is still running
  -> security upgrade-target calculation
  -> graph hygiene findings
  -> row composition
  -> persist cache
  -> host message serialization/postMessage
  -> webview validation/state processing
  -> filter/search/sort/paginate
  -> current-page React render
```

The final controlled 150-direct/1,350-node timeline was:

| Stage | Duration |
| --- | ---: |
| Manifest parse | 0.1 ms |
| Lockfile parse | 0.8 ms |
| Dependency graph build | 1.0 ms |
| Bulk advisory request | 30.5 ms, overlapped |
| npm audit | 50.4 ms, overlapped |
| Version metadata | 168.5 ms |
| Advisory attribution | 0.4 ms |
| Patched-version metadata | 84.5 ms |
| Row composition + hygiene | 20.3 ms |
| Total wall clock | 280.5 ms |

Overlapped stages intentionally sum to more than wall-clock time. Audit begins once the graph supplies the trusted direct-package allow-list and is consumed after patched metadata. In this fixture its full 50.4 ms was hidden. Audit remains part of final authoritative row composition because it uniquely contributes npm's `fixAvailable` guidance.

Project discovery, manifest/lockfile reads, registry configuration, persisted storage, `postMessage`, and actual React paint depend on the VS Code Extension Host and workspace filesystem. Structured instrumentation covers those stages, but the GUI was unavailable for this run.

## Registry request graph

For the cold 150-direct/30-flagged deterministic fixture:

```text
150 direct dependencies / 1,350 graph nodes

/latest requests                         150
full packument network requests           30
  version-resolution escalation            0
  patched-version analysis                30
  upgrade-target fallback                  0 new requests
scan-local packument reuse                 30
bulk advisory POST                          1
npm audit subprocess                        1
ETag hits / 304s                            0 / 0 (cold store)
```

Every full packument was required to calculate a patched version for one distinct flagged package. The later security-target fallback reused the same scan-local promise/document and caused no second network request. `/latest` remains the default because it is substantially smaller than a full packument and already supplies stable latest/deprecation metadata.

Instrumentation now records total registry response wire bytes, bulk request bytes, ETag/304 counts, scan-local hits, and the reason that caused each actual packument request. It records counts only—never URLs, credentials, headers, `.npmrc` contents, or tokens.

## Bottlenecks found

### P1 — bulk advisories serialized behind version metadata

The graph was complete, but the pipeline awaited the entire bounded `/latest` pool before sending the one bulk advisory POST. The two results are independent until attribution/composition.

- Baseline, 125 direct: 279.0 ms
- After overlap, 125 direct: 250.3 ms
- Improvement: 28.7 ms / 10.3% in the deterministic latency model
- Real-network observation: the standalone live advisory POST took 557.38 ms; overlap can hide up to that latency when version work lasts as long, but this is not a full production-scan claim

Risk: one extra HTTP request is active alongside the version pool. The advisory endpoint is npm-owned and usually a different host from a configured corporate registry. The existing version pool remains bounded; patched packuments do not start until advisory attribution finishes. Cancellation and failures remain isolated.

### P1 — sequential usage file reads

The analyzer already parsed each source once for all requested packages, but it still awaited each filesystem read serially. On a 6,000-file cap, storage/provider latency was multiplied by file count.

- Baseline model: 400 files × 2 ms = 960.0 ms measured
- Bounded batches of 8: 114.6 ms
- Improvement: 845.4 ms / 88.1%

Reads now occur in deterministic batches of eight. Results are consumed in input order, at most eight source texts are retained, unreadable files remain isolated, progress reflects consumed files, and cancellation prevents later batches from starting.

### P1 perceived — manual refresh replaced useful rows with a skeleton

Same-project manual/post-action refresh discarded `lastResult`, even though the controller already had a safe display snapshot. It forced the user to wait for full completion before seeing any table.

- Blocking time to useful content: 276.8 ms
- Table-preserving time to useful content: 3.8 ms
- Improvement: 273.0 ms / 98.6% in the controlled delivery run

Upgrade eligibility is revoked before the disk read. The retained table is explicitly stale and actions remain disabled until a matching generation completes. Project switches still clear the previous project's data.

### P2 correctness/performance — retained HTTP abort listeners

Each request attached a listener to the shared scan `AbortSignal` and only released it when the entire signal became unreachable. Large scans could retain one listener per request and cross EventTarget warning thresholds even though registry concurrency was bounded.

The transport now removes the listener at every resolve/reject boundary and closes the abort-registration race. A deterministic test verifies zero remaining listeners after a settled request. Active listener pressure is now proportional to in-flight HTTP work (approximately the pool plus the advisory POST), not dependency count.

### P3 — local graph, table, modal, and payload work

Measured at 150 rows / 1,350 nodes:

- npm lockfile parse/build: 0.9/1.2 ms
- pnpm lockfile parse/build: 2.2/3.3 ms
- advisory attribution: 0.4 ms
- table filter/search/sort/paginate/metrics: 0.6 ms, 25 rows rendered
- Manage Dependencies criteria/counts/tags/selection: 0.1 ms
- rich host→webview payload: 57,243 bytes, 0.1 ms serialize, 0.2 ms parse

These paths are not material next to network and workspace I/O, so no micro-optimization or protocol complexity was added.

## Unexpected findings

This separate pass looked for work not predicted by the previous performance report.

1. Registry abort listeners accumulated by completed request count rather than in-flight count. Fixed.
2. Same-project manual refresh intentionally destroyed useful UI state. Fixed.
3. The one-pass Usage Analyzer still serialized physical file reads. Fixed.
4. Selected-project reload runs a workspace-wide lockfile glob every time to detect a newly nearer lockfile. This can be significant in very large monorepos, but caching it requires correct create/delete/topology invalidation and Extension Host evidence. Deferred.
5. Manual Refresh deliberately forces a background usage recheck so source-only edits can refresh likely-unused findings even when the manifest/lockfile fingerprint is unchanged. It happens after the table is useful and is now bounded, so the behavior was retained.
6. Bulk upgrade and bulk remove already load the project once and build one normalized graph for all selected changes. No N× graph/manifest regression was found.
7. Bulk transitive remediation reloads and revalidates project/package-manager state for each target. Sharing it could save work, but a long sequential batch can overlap external file changes; the repeated freshness boundary was retained rather than returning stale security-sensitive conclusions.
8. Activation performs command registration only. No registry, filesystem scan, subprocess, or usage analysis runs before the dashboard is requested. The bundled module-loading cost was not measurable without the Extension Host, so no speculative dynamic imports were added.

## Optimization table

| Bottleneck | Priority | Before | After | Improvement | Implemented |
| --- | ---: | ---: | ---: | ---: | --- |
| Version/advisory serialization, 125 direct | P1 | 279.0 ms | 250.3 ms | 28.7 ms / 10.3% | Yes |
| Usage reads, 400 × 2 ms | P1 | 960.0 ms | 114.6 ms | 845.4 ms / 88.1% | Yes |
| Manual refresh time to useful table | P1 | 276.8 ms | 3.8 ms | 273.0 ms / 98.6% | Yes |
| Settled HTTP abort listeners | P2 | O(total requests) retained | O(in-flight requests) | bounded listener pressure | Yes |
| npm/pnpm graph CPU | P3 | <= 5.5 ms combined parse/build | unchanged | not material | No |
| Table/manage modal CPU | P3 | <= 0.6 ms | unchanged | not material | No |
| Webview payload | P3 | 57 KB, <= 0.2 ms local serialization step | unchanged | not material | No |

## Concurrency and HTTP behavior

Controlled 50-direct results:

| Registry limit | Total | Peak patched packuments |
| ---: | ---: | ---: |
| 4 | 181.7 ms | 4 |
| 8 | 106.3 ms | 8 |
| 12 | 68.6 ms | 10 |
| 16 | 58.9 ms | 10 |

This deterministic delay model contains no bandwidth, proxy, 429, or server-pressure penalty, so it predictably rewards higher concurrency. The default remains 8 because the earlier real-network observation flattened above 8 and corporate proxies are less forgiving. No custom connection pool was introduced. `NodeHttpClient` continues using `node:https` so VS Code's proxy-agent integration is preserved; the Node 22 global HTTPS agent provides connection reuse. Timeout remains 10 seconds per request, failures remain per-package, and there is no broad retry storm.

## Cache and loading behavior

- Cold: skeleton plus real stage/count progress; final rows remain authoritative and arrive as one batch.
- Warm/panel reopen: freshly read manifest/lockfile fingerprint validates persisted rows; a fresh entry posts immediately and skips network.
- TTL-stale: cached rows post immediately as stale, then background revalidation replaces them.
- Manual refresh: re-reads disk and forces a scan, but keeps same-project rows visible as stale.
- File changes: 300 ms debounce/coalescing remains; generation checks and aborts prevent stale results. The prior table stays visible.
- Project switch: never shows the previous project's rows under the new identity.
- Cache serialization: the measured rich outgoing payload is only 57 KB; no compression or lazy detail protocol is justified.

Progress now reflects concurrent reality: advisory work starts beside versions, version settlement counts remain visible, and if versions finish first the UI switches back to “Checking vulnerability advisories…” rather than stopping at `N of N`. Patched versions, npm audit, and final row composition keep their real stage labels. No fake percentage is emitted.

## Usage Analyzer

The important existing one-pass design is preserved:

```text
discover source files once
  -> read at most 8 files concurrently
  -> consume each batch in deterministic order
  -> extract imports once per file
  -> bucket references for every requested dependency
  -> scan the few configuration files
```

The cache lookup remains O(1) over an already-computed manifest/lockfile fingerprint. Source contents are released after each batch; no whole-workspace text cache was introduced. Configuration scanning is still config-files × dependencies, but config files are few and no evidence justified a token index. Generated/vendor directories remain excluded through the shared VS Code glob exclusions.

## Safety and correctness retained

No optimization changes Workspace Trust, protocol validation, source fingerprints, generation checks, candidate validation, fresh disk reads, resolver verification, snapshots, verification/rollback, advisory attribution, or remediation correctness. Preflight remains on demand and independently re-fetches/revalidates security-sensitive inputs before execution. Scan-local packuments never cross into later Preflight.

## Deferred opportunities

- Progressive basic/version/security row batches: cold useful content could arrive earlier, but partial cache semantics, vulnerability-default sorting, filters, pagination, and generation-stable batched updates require a larger protocol/state change. Current measurements support doing this only with Extension Host/React profiling.
- Audit-after-render: audit is fully hidden in the controlled large timeline. Moving it after final rows would create a second security revision and is not justified by current evidence.
- Shared per-host limiter for version/advisory overlap: current overlap adds only one request and uses different logical endpoints. Add a shared limiter only if corporate-proxy measurements show pressure.
- Lockfile inventory caching for very large monorepos: requires VS Code `findFiles` measurements and topology-safe invalidation.
- Bulk remediation context reuse: retain per-target freshness until a generation-bound shared context can prove equivalent safety.
- Real large npm/pnpm project and GUI profiling: unavailable in this environment and required before claiming production time-to-paint.

## Reproduction

Run the deterministic suite with:

```bash
npm run benchmark:performance
```

Run the real advisory smoke check separately with:

```bash
npm run test:live
```

The live check passed 1/1 in 557.38 ms for the request (633.84 ms test-runner duration). It does not represent a full dashboard scan.
