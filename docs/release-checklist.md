# v1 Release Checklist

This checklist is the release gate for Dependency Dashboard 1.0.0. Run commands
from the repository root with Node.js 22 or newer.

## Code and product

- [x] npm and pnpm dashboard scans use disposable real-project fixtures.
- [x] Manage Dependency, Upgrade Review, Removal Review, Project Maintenance,
  Smart Cleanup, refresh, close/reopen, and retained-result paths have automated
  Extension Host coverage.
- [x] A ten-minute retained-result soak passes without silently clearing results.
- [x] Dark, light, and high-contrast VS Code themes keep Smart Cleanup readable.
- [x] Workspace Trust, script policy, stale-source revalidation, rollback, and
  concurrent-edit protections are documented and tested.
- [x] No telemetry is collected; every network destination and submitted field is
  documented in the README.

## Automated release gate

```bash
npm ci
npm run test:release
npm run build -- --production
npm run package -- --out dependency-dashboard-1.0.0.vsix
```

- [ ] CI passes on Ubuntu and Windows for the current and minimum-supported VS
  Code versions.
- [x] The packaged VSIX installs into a clean VS Code profile and the dashboard
  opens against a disposable npm project.
- [x] `unzip -l dependency-dashboard-1.0.0.vsix` contains runtime bundles,
  manifest, README, changelog, license, icon, and screenshots—no source, tests,
  credentials, local configuration, or agent state.

## Marketplace and repository

- [x] Version is `1.0.0`, changelog is dated, license is MIT, and README includes
  product screenshots, privacy behavior, limitations, and installation guidance.
- [x] `CONTRIBUTING.md` and `SECURITY.md` define the open-source contribution and
  private-reporting paths.
- [ ] Replace `CHANGEME` in `package.json` with the repository owner's registered
  VS Code Marketplace publisher ID. Do not guess this value.
- [ ] Confirm the Marketplace display name, icon, categories, repository links,
  support link, and stable (non-preview) channel in the final listing preview.
- [ ] Merge the release pull request only after required CI is green.
- [ ] Tag the merged commit `v1.0.0`, create GitHub release notes from
  `CHANGELOG.md`, attach the tested VSIX, and publish the same bits to the
  Marketplace.
- [ ] Install the Marketplace artifact once on a clean profile and confirm the
  version, commands, icon, dashboard, and one read-only refresh.

## Manual platform smoke test

- [x] macOS: disposable-project development-host run and theme checks.
- [ ] Windows: installed-VSIX launch, npm project, refresh, and one review flow.
- [ ] Linux: installed-VSIX launch, npm or pnpm project, refresh, and one review
  flow. Automated Linux Extension Host coverage is required even when this manual
  check is deferred.

Record the tested VS Code version, operating system, package manager, VSIX SHA-256,
and any accepted limitation in the GitHub release notes.
