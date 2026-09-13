# Deferred work for a production-ready v1

Status: planning notes only; not implemented by this document. Keep this file uncommitted until the owner decides to include it. Updated 2026-08-31.

## Scope of the current stabilization work

The current work addresses predictable analysis performance, focused module extraction, misleading upgrade recommendations, partially compatible Node ranges, the target-version label, and accurate network disclosures. The items below remain follow-up work; passing current unit tests does not complete them.

## Product and maintenance improvements

- **Clearer conclusions across every review.** Use a consistent summary of the intended change, verified benefit, remaining uncertainty, and next action in upgrade, removal, transitive fixes, and Smart Cleanup. Preserve the distinction between confirmed conflicts and review advice. This extends beyond the upgrade-recommendation correction in the current work.
- **Redacted troubleshooting report.** Add an explicit user action to copy/export analysis stage durations, stable failure codes, extension/package-manager versions, and cache/coverage information. Exclude source snippets, credentials, registry tokens, sensitive URLs, and absolute project paths by default. Preview the report before sharing; do not add background telemetry.
- **Continue small module extractions.** Separate review orchestration, evidence acquisition, decision/presentation logic, and mutation lifecycle only where an existing boundary is clear. Reuse shared UI components and helpers rather than copying them. Preserve cancellation, source identity, and ownership of cached results. Avoid a large rewrite just before release.
- **Representative performance baselines.** Record cold/warm timings and time to first useful result on real npm and pnpm projects of several sizes. Existing synthetic timings and any new local cache tests are not a claim about production network latency. Use results to set realistic stage budgets and regression thresholds.

## Release gates

### 1. Real Extension Host automation

Add tests that launch VS Code with the packaged extension rather than only mocking the VS Code API. Cover activation in trusted/untrusted workspaces, project switching, webview open/close/reload, long-open review results, true versus unrelated watcher changes, cancellation, and return navigation between Smart Cleanup and package reviews.

Acceptance: the workflow reproductions run reliably in CI against the supported minimum and current stable VS Code versions. Existing unit/protocol tests remain in place.

### 2. Mutation and recovery matrix

Exercise real package-manager fixtures for upgrade, removal, duplicate consolidation, and transitive fixes. Include success, no-op, cancellation before/during installation, resolver/network failure, verification-script failure, concurrent manifest/lockfile edits, rollback failure, interrupted extension sessions, and rechecking after a successful fix.

Acceptance: no unconfirmed mutation occurs; a failed or interrupted operation reports the actual manifest/lockfile state and a usable recovery path. Never overwrite unrelated user changes during rollback. Recovery-point behavior and temporary-directory cleanup are verified, not assumed from mocks.

### 3. Packaged-extension compatibility

Smoke-test VSIX installation, activation, dashboard rendering, analysis, and one reversible confirmed change on Windows, macOS, and Linux. Include paths with spaces, package-manager executable discovery, npm and the supported pnpm lockfile versions, minimum supported VS Code, and current stable VS Code. Declare limitations for remote, virtual, and web workspaces rather than implying support that was not tested.

Acceptance: publish an explicit support matrix and confirm the package contains only intended runtime files and assets. Current Linux/Windows build and package CI is useful but does not replace runtime coverage.

### 4. External-service and privacy behavior

Test offline operation, timeouts, partial responses, rate limits, missing CVE enrichment, custom/scoped registries, and credential-safe error output. Review whether private projects need an explicit public-advisory/enrichment opt-out or policy control; the current documentation disclosure is not such a control.

Acceptance: unavailable data never becomes "safe" or "no vulnerabilities," cached data is identified honestly, and no diagnostic output or persisted cache leaks credentials. Public npm/GitHub request behavior matches the privacy documentation.

### 5. Release identity and documentation

- Replace the placeholder publisher with the owner's actual Marketplace publisher; the owner must provide or approve that identity.
- Choose the v1/pre-release version and update the changelog.
- Update README, screenshots, feature descriptions, supported package managers, permissions, limitations, and troubleshooting instructions to match the shipped UI.
- Run type checking, the full automated suite, production build, package inspection, and install smoke tests from a clean checkout.

Acceptance: a new contributor can reproduce the build and a user can understand what the extension supports without relying on development conversations.

### 6. Small pre-release pilot

Ask a small group to try representative real npm/pnpm projects, including a monorepo and a project with transitive vulnerabilities. Collect explicit user feedback on confusing outcomes and failed workflows. Track reproducible failures before promoting the same release candidate to stable.

## Intentionally outside v1

- Java/Spring and other non-npm ecosystems.
- Container images, global npm installations, and machine/runtime-wide scanning (see the existing future container/runtime scanning notes).
- Broad deprecated-API detection beyond explicit, evidence-backed rules.
- Additional package managers or deployment environments without dedicated verification.

These are future product decisions, not dependencies for completing the current desktop npm/pnpm extension. Revisit them after a reliable v1 ships.
