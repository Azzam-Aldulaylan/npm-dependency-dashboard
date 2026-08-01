# VS Code Extension: npm Dependency Dashboard

## Overview
A lightweight VS Code extension that gives a visual, in-editor dashboard of all npm packages installed in a project (React, Next.js, or any Node-based repo). Instead of running `npm outdated` / `npm audit` manually in the terminal, the user gets a single panel showing package name, current version, available update, and vulnerability status — with a one-click upgrade action.

**Target platform:** Visual Studio Code Extension (Marketplace)
**Language:** TypeScript
**License model:** Open source, public repository

---

## Goals
- Give a fast, glanceable view of dependency health without leaving the editor
- Surface security risk (vulnerabilities) clearly, using color-coded status tags
- Keep the extension slim, low-resource, and fast — no heavy background processes
- Ship as MVP first, then layer in convenience features

---

## MVP Feature Set

### Core Table View
A panel (VS Code Webview) rendering a table with the following columns:

| Column | Description |
|---|---|
| Package Name | Name of the installed dependency |
| Current Version | Version currently installed (lockfile-resolved) |
| Available Version | Highest **stable** version satisfying the update rule below |
| Vulnerability Status | Colorized tag (e.g., green = none, yellow = low/moderate, red = high/critical) |
| Action | "Upgrade" button to bump the package |

### Data Sources
- **Package list & current versions:** parsed from `package.json` and the lockfile. "Current Version" is defined as the **lockfile-resolved version** (what's actually installed), not the `package.json` range — if no lockfile exists, fall back to showing the range with an "unresolved" indicator.
- **Available updates:** npm registry API, abbreviated packument only (see Technical Architecture — the `/<pkg>/latest` shortcut was considered and dropped, see below).
- **Vulnerabilities:** `npm audit --json` is the **primary** source (see Vulnerability Scope below for why). The bulk advisories endpoint (`POST /-/npm/v1/security/advisories/bulk`) is a **fallback** for when no lockfile is present or the npm CLI isn't reachable.

### Vulnerability Scope: Direct vs Transitive Dependencies
Most real-world vulnerabilities live in transitive dependencies, not the packages listed directly in `package.json`. Decision for MVP:

- The table's primary rows are **direct dependencies**.
- A direct dependency's vulnerability tag **aggregates** any advisory found anywhere in its subtree.
- Each row is expandable to show which nested package is actually flagged and the path to it.
- The **"Upgrade" button only appears if a fix exists at the direct-dependency level** (i.e. bumping the direct package resolves the transitive advisory).

**Why `npm audit --json` is the primary source, not the bulk endpoint:** the bulk advisories endpoint takes a package-name → version map and returns advisories keyed by package name — it returns **no dependency paths and no fix information**. Both of the features above (expandable path, fix-gated upgrade button) depend on data the bulk endpoint doesn't have. `npm audit --json` returns both — with implementation caveats:

- **Exit code handling:** `npm audit --json` exits with code `1` when it finds vulnerabilities — that's the *normal, successful* outcome, not a failure. A `child_process` wrapper that naively branches on exit code (`if (exitCode !== 0) fallback`) will treat every audit that actually finds something as a failure and silently drop to the bulk-endpoint fallback — defeating the entire point of using audit as primary. **Branch on whether stdout parses as valid JSON, not on exit code.**
- **`fixAvailable` has three shapes, not one:** it can be `true` (fixable in-place without a top-level version bump), `false` (no fix available), or an object `{ name, version, isSemVerMajor }` (fix exists but requires a specific version, possibly a major bump). The upgrade-gating rule needs to handle all three — only `true` and the object form (when not a major bump, or with a confirmation step when it is) should surface the "Upgrade" button.
- **`effects` is a one-hop reverse edge, not a full path chain** — it points to the immediate parent only (e.g. `form-data → effects: ['request']`), not the complete chain to the direct dependency. Building the expandable path-to-flagged-package view requires **recursively walking `effects`** (or the `via`/`nodes` structure) rather than reading a single ready-made field. Related: audit output includes an `isDirect` boolean per entry — a cleaner way to identify which rows are direct dependencies than cross-referencing against `package.json`.
- **Confirmed (in the spec's favor):** `npm audit` works with only a lockfile present — no `node_modules` install needed (verifiable with `--package-lock-only`).

When only the bulk-endpoint fallback is available (no lockfile / CLI unreachable), these two features degrade gracefully: the tag still shows "vulnerable," but without path drilldown or the fix-gated upgrade button.
- Advisory requests (via either source) target npm's own advisory infrastructure regardless of the resolved `.npmrc` registry — see Registry Resolution below.

### Refresh Behavior
- On panel open: check cache validity first. If a warm, non-expired cache exists, render from it immediately; only run the full check cycle (read `package.json` → fetch versions → fetch vulnerabilities) if the cache is cold or expired. (Corrects an earlier contradiction — "always runs the full cycle on open" and "has a cache with a TTL" can't both be true.)
- Manual "Refresh" button always bypasses cache and re-runs the full cycle, regardless of TTL.
- Optional background refresh every ~30 minutes while the panel stays open (only if actively open — no polling when closed).

---

## Additional Features (Post-MVP, Prioritized)

1. **Priority filter** — filter the table by vulnerability severity (critical/high/moderate/low/none)
2. **Search bar** — quickly locate a specific package by name
3. **Dependency tree visualization** — see which packages depend on which
4. **Refresh button** — (also listed under MVP; reinforced here as a standalone feature for the tree/filtered views)
5. **Dev dependency toggle** — show/hide `devDependencies` to focus on production packages only
6. **Changelog viewer** — preview what changed in the available update before upgrading

---

## Technical Architecture

- **Extension host:** TypeScript, using the VS Code Extension API
- **UI layer:** Webview panel, built with React (keeps it consistent with the rest of the stack and snappy to render)
- **Data layer:** reads local `package.json` and lockfile (npm only, see Package Manager scope below); version data comes from the npm registry, vulnerability data comes from the local `npm audit` CLI or the bulk advisories endpoint as fallback.
- **Version fetching:** the npm registry has no batch endpoint for version data. Use concurrency-limited per-package requests against the abbreviated packument (`Accept: application/vnd.npm.install-v1+json`). Correction: the abbreviated format is a real but modest saving (~45%, not an order of magnitude as originally implied) — a package with a large version history (e.g. `typescript`) can still be several MB of JSON to parse even abbreviated. Two mitigations: (1) the registry honors `If-None-Match`/ETags, so a conditional request on an unchanged package returns a 304 with no body — use this on repeat fetches; (2) since packument data is **project-independent** (a package's version history doesn't change based on which project references it), it belongs in a **global** cache shared across projects, not the per-workspace cache described below. (`/<pkg>/latest` was considered as a lighter alternative but only returns the `latest` dist-tag, not enough to detect "newer version within range" — dropped.)
- **Pre-release handling (corrected):** the naive rule — "highest published version greater than installed by semver" — is broken. Semver precedence compares `major.minor.patch` first and only falls back to the pre-release tag when those are equal, so a package with any published pre-release (e.g. `19.3.0-canary-xxx`) will outrank the actual latest stable release (`19.2.8`) purely because `19.3.0 > 19.2.8` — the canary would show as the "available update" for every user of that package, all the time. Correct rule, matching `npm outdated`'s model:
  - **Wanted** = highest version satisfying the `package.json` semver range.
  - **Latest** = highest **stable** (non-pre-release) published version.
  - Pre-release versions are only considered "available" when the **installed** version is itself a pre-release (so a project intentionally tracking a pre-release track doesn't get falsely flagged as behind a lower stable release).
- **Vulnerability fetching:** `npm audit --json` (primary) or the bulk advisories endpoint (fallback) — see Vulnerability Scope above.
- **Registry resolution (split rule):**
  - **Version data** follows the resolved `.npmrc` registry (project-level → user-level → default `registry.npmjs.org`), so proxy/Artifactory users don't get an error table on first run. No authentication support yet (deferred to v2/v3).
  - **Advisory data** (via `npm audit` or the bulk fallback) always targets npm's own advisory infrastructure, regardless of the resolved registry — private mirrors generally don't implement the advisory endpoint.
- **Package manager scope (MVP):** **npm only.** `package-lock.json` is the only lockfile parsed for resolved versions and audit data. pnpm/yarn support — including `workspace:*` protocol handling and per-PM lockfile parsing — is deferred to whenever multi-PM support is added (not MVP).

### Caching
- **Storage (split):** install-state results (current versions, audit output — inherently project-specific) go in `workspaceState`. Packument/version data (project-independent — a package's version history is the same regardless of which project references it) goes in `globalState`, shared across all projects. See Version Fetching above for why this matters at scale.
- **TTL:** ~30 minutes as a fallback ceiling.
- **Invalidation:** a file watcher on `package.json` / lockfile triggers a fresh check; manual refresh always bypasses cache.
- **Offline behavior:** if a warm cache exists, show it marked as stale rather than blocking. If the cache is cold and there's no network, show an explicit empty/error state with a retry action — never a silent blank table.

### Monorepo Handling
- Detect all `package.json` files in the workspace using VS Code's workspace search API (respects `.gitignore`), with explicit exclusions for `node_modules`, `.git`, and common build directories — avoid a raw recursive filesystem scan on large repos.
- If more than one `package.json` is found, let the user pick which one to view, or show each in its own tab.
- **Correction — npm workspaces are an MVP-scope problem, not just a pnpm/yarn one:** MVP explicitly supports npm-only + monorepos, but npm's own workspace feature links internal packages locally (`"link": true` in `package-lock.json`), and those packages have no registry entry. This is the same "no registry match" failure mode as pnpm/yarn's `workspace:*` protocol, just without that literal syntax — it can't be deferred to v3 the way `workspace:*` handling was. **Fix (MVP-scope):** detect lockfile entries with `"link": true` and tag them as "local/workspace," skipping the version/vulnerability lookup rather than erroring — same treatment as the deferred `workspace:*` case, just needed now.
- **Non-registry dependency specifiers:** `file:`, `link:`, `git:`/`github:` URLs, `npm:` aliases, and `overrides` entries have no registry version to resolve. Apply the same graceful tagging as above (e.g. "local," "git," "aliased") rather than erroring or leaving a broken row.
- **Lockfile version handling:** parse `lockfileVersion` explicitly. v1 has only a `dependencies` key; v2 has both `dependencies` and `packages` (target `packages` as the primary parse path, it's the modern shape); v3 has only `packages`. Also check for `npm-shrinkwrap.json` first — it takes precedence over `package-lock.json` when both are present.
- No forced single-project assumption.

### Error Handling
- If the registry or vulnerability API is unreachable, or a package is unpublished/unresolvable: show a default error state in the table row (or panel-level banner) with a "Refresh" action to retry
- Fail gracefully — one bad package shouldn't break the whole table

### Performance Considerations
- No constant polling; refresh is event-driven (open panel, manual click, or the ~30-min background check while open)
- Cache aggressively
- Keep the webview bundle small — avoid unnecessary dependencies in the UI layer

---

## Explicitly Out of Scope for v1

- **Authentication / private npm registries** — deferred to v2/v3. No token handling for private packages in MVP.
- **pnpm/yarn support** — MVP is npm-only (`package-lock.json` only). Includes `workspace:*` protocol handling and any per-PM lockfile parsing.
- **Telemetry** — worth adding later to understand feature usage, not required for MVP.
- **Versioning/compatibility strategy for npm API changes** — to be handled as a maintenance concern post-launch, not a launch blocker.

---

## Publishing / Housekeeping Requirements (MVP blockers, not features)
These aren't user-facing features but are required before a Marketplace listing is possible:

- **LICENSE file** — required for Marketplace publishing.
- **Minimum VS Code engine version** — pin in `package.json`'s `engines.vscode`.
- **Activation events** — lazy activation only: `workspaceContains:**/package.json` + `onCommand`. Avoid `*` (activates on every VS Code launch, hurts startup time).
- **Webview security** — CSP and nonce on the webview content.
- **Bundler** — esbuild (fast, standard choice for VS Code extensions) over webpack.
- **Testing/CI** — at minimum a lint + build check on PRs before this goes public.

## Cheap Wins (free from data already being fetched)
- **Deprecated flag** — confirmed present in the abbreviated packument; surface it as a tag alongside the vulnerability status.
- **License field** — ~~correction~~: NOT included in the abbreviated packument (`Accept: application/vnd.npm.install-v1+json` strips it along with description, readme, repository, etc. — that's the entire point of the abbreviated format). Showing it would require a separate full-packument fetch per package, defeating the reason for using the abbreviated format in the first place. **Dropped from MVP cheap wins** — revisit only if a future version fetches full packuments for some other reason.

## Security: Workspace Trust (MVP blocker — newly identified)
Not previously addressed, and it's a real gap, not a nice-to-have:

- The "Upgrade" action runs `npm install`, which executes lifecycle scripts (`preinstall`/`postinstall`) — arbitrary code execution from whatever's in the repo. Opening an untrusted/cloned repo and clicking Upgrade would run that code without any confirmation beyond the upgrade click itself.
- VS Code's [Workspace Trust API](https://code.visualstudio.com/api/extension-guides/workspace-trust) exists specifically for this: extensions that execute code or read arbitrary workspace content are expected to declare `capabilities.untrustedWorkspaces` in `package.json` and gate execution on trust state. Marketplace review checks for this.
- **Compounding risk:** since version-data fetches follow the resolved `.npmrc` registry (project-level first), a malicious repo could commit a `.npmrc` pointing at an attacker-controlled host — silently redirecting the extension's network requests before the user does anything at all.
- **MVP requirement:** declare `capabilities.untrustedWorkspaces` (limited or false, gating execution), and disable/warn on the Upgrade action and `.npmrc`-based registry resolution when the workspace is untrusted.

## npm Binary Resolution (missing from spec — newly identified)
The spec's fallback trigger for "no lockfile / CLI unreachable" assumed npm would generally be reachable, but never defined *how* it's located — this isn't an edge case:

- GUI-launched VS Code on macOS does **not** inherit the interactive login shell's PATH. Version managers like nvm, fnm, and volta set `npm`/`node` PATH entries via shell rc files (`.zshrc`, `.bashrc`) — those only apply to interactive shell sessions, not GUI-launched processes. A large fraction of users on these version managers would have **no npm visible to the extension host** and get permanently pushed onto the degraded bulk-endpoint fallback.
- **MVP requirement:** an explicit resolution strategy — e.g. check common version-manager install locations, or invoke the CLI via a login shell (`spawn(shell, ['-l', '-i', '-c', 'npm ...'])`) rather than assuming `npm` resolves from the extension host's inherited PATH.

## Naming Note
"npm" is a trademark of npm, Inc. / GitHub. Marketplace listings referencing it in passing generally survive, but worth reviewing before finalizing the extension's **display name** on the Marketplace (the repo name itself is fine as-is).

## Business Context

- **Primary use case:** personal projects first (including React / Next.js codebases)
- **Distribution:** planned publish to the VS Code Marketplace
- **Repo:** public and open source — allows community trust, bug reports, and contributions

---

## Roadmap Summary

| Phase | Scope |
|---|---|
| MVP (v1) | Core table (name, current version, available version, vulnerability tag, upgrade button), manual + auto refresh, monorepo detection (incl. npm workspace linking + non-registry specs), basic error handling, caching, concurrency-limited fetching, Workspace Trust gating, npm binary resolution |
| v1.x | Priority filter, search, dev dependency toggle |
| v2 | Dependency tree visualization, changelog viewer |
| v3 | pnpm/yarn support (workspace:* handling, per-PM lockfile parsing), authentication for private registries, telemetry, versioning strategy for registry API changes |

---

## Resolved Decisions (previously open questions)
- **What "Upgrade" does:** confirm, then run in a **visible VS Code task** (e.g. `npm install <pkg>@<version>`), not a silent `child_process`. Failures need to surface, since this rewrites both `package.json` and the lockfile.
- **Vulnerability tag color scale/thresholds:** still to be finalized visually, but the underlying severity levels (critical/high/moderate/low/none) are already defined by the audit/advisory data itself.
- **Marketplace listing details** (icon, display name, description): deferred until naming is finalized — see Naming Note above.
