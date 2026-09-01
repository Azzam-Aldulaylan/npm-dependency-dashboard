# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-01

### Added

- Direct-dependency dashboard for npm and pnpm projects with installed, wanted,
  and latest versions; update classification; dependency-type and hygiene
  filters; search by package, vulnerability ID, or dependency path; and
  monorepo project selection.
- Vulnerability attribution through the complete dependency graph, including
  severity, affected package, full introduction path, GHSA and CVE references,
  NVD links for CVEs, patched ranges, and security outcomes after proposed
  changes.
- Compatibility-aware Upgrade Review with peer and engine checks, package
  exports and published-file inspection, source/config analysis, focused Next.js
  migration rules, coordinated upgrade plans, and explicit partial/unavailable
  coverage states.
- Removal Review with bounded project-usage analysis, dependency requirements,
  package-script/configuration evidence, security impact, and final project-state
  revalidation.
- Project Maintenance bulk review and Smart Cleanup for unused candidates,
  installed-version deprecations, simulated duplicate consolidation, selection
  security impact, final preflight, restore points, and visual completion results.
- Bounded transitive vulnerability remediation plans that can update a child
  package without unnecessarily changing its direct parent.
- Transactional npm and pnpm changes with lifecycle scripts disabled by default,
  optional user-selected verification scripts, compare-and-swap protection,
  rollback, and visible VS Code Tasks.
- Persistent project and registry caches, project file and Git branch watchers,
  one-hour analysis-result retention, manual refresh, and background revalidation.
- Disposable npm/pnpm transaction fixtures and real VS Code Extension Host tests,
  including stable and minimum-supported VS Code versions and result-retention
  soak coverage.

### Changed

- Analysis work is staged and cached so fast inventory results render before
  slower network, compatibility, deprecation, or remediation checks finish.
- Dashboard, package workspace, bulk maintenance, and Smart Cleanup now share
  reusable status banners, buttons, severity badges, advisory links, and
  theme-aware visual tokens.
- Smart Cleanup contrast and information hierarchy now remain readable in dark,
  light, and high-contrast VS Code themes.

### Fixed

- Prevented analyzers, temporary package inspection, Git activity, and unchanged
  project files from falsely invalidating Upgrade Review results.
- Preserved Upgrade Review and Smart Cleanup state across tab switches,
  close/reopen flows, refreshes, and long reading sessions.
- Kept package-workspace tabs stable and non-scrolling for long vulnerability and
  compatibility results.
- Corrected vulnerability totals versus vulnerable dependency counts, advisory
  filtering/accordion expansion, severity ordering, CVE enrichment, and removal
  of duplicate npm advisory IDs from the UI.
- Kept removal, remediation, and stale-result outcomes inside the active workflow
  instead of replacing them with unrelated dashboard errors.

### Security

- Requires Workspace Trust before reading project registry configuration or
  running package-manager commands.
- Rejects unresolved environment substitutions in project `.npmrc` registry
  values and never persists authentication keys.
- Revalidates source fingerprints and transaction ownership immediately before a
  dependency mutation, and refuses rollback over concurrent user edits.

[1.0.0]: https://github.com/Azzam-Aldulaylan/npm-dependency-dashboard/releases/tag/v1.0.0
