# Changelog

All notable changes to this extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Nothing has been published to the Marketplace yet, so there is a single entry
for everything built so far rather than a per-version history.

## [Unreleased] - 0.0.1

Initial feature set, not yet published:

- Safe upgrade-assistant flow with on-demand peer compatibility preflight,
  isolated package-manager resolver verification, bounded coordinated upgrade
  plans, transactional snapshots, optional explicit verification scripts, and
  compare-and-swap rollback.
- Coordinated plans can span production, development, and optional dependency
  blocks through host-generated manifest staging and one npm/pnpm reconciliation
  install.
- pnpm lockfile v9, workspace importer, advisory graph, watching, preflight,
  and structured upgrade execution support alongside the existing npm flow.

- Dashboard panel listing every direct npm dependency with Current, Wanted,
  and Latest versions.
- Vulnerability detection via npm's bulk advisories endpoint, with optional
  `npm audit` enrichment for fix availability, severity badges, and
  expandable per-advisory detail (affected transitive package + dependency
  path).
- One-click Upgrade action: modal confirmation, Workspace Trust re-check,
  and a visible `npm install` task with `--ignore-scripts` on by default.
- Workspace Trust required to activate at all; re-checked before reading a
  project's `.npmrc` and again immediately before any upgrade.
- Monorepo / multi-root support with a project picker and correct npm
  workspace lockfile resolution.
- Persisted, TTL-based caching (`dependencyDashboard.cacheTtlMinutes`) with
  instant warm-cache renders, background revalidation, a fixed 30-minute
  background refresh timer, and automatic reload on external `package.json`/
  lockfile changes.
- No telemetry. See the [README's privacy section](README.md#privacy-and-network-access)
  for the exact npm endpoints contacted.
