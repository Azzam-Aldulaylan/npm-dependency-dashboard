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
| Current Version | Version currently installed (from `package.json` / lockfile) |
| Available Version | Latest version available on the npm registry |
| Vulnerability Status | Colorized tag (e.g., green = none, yellow = low/moderate, red = high/critical) |
| Action | "Upgrade" button to bump the package |

### Data Sources
- **Package list & current versions:** parsed from `package.json` (and lockfile for resolved versions)
- **Available updates:** npm registry API (per-package, abbreviated packument — see Technical Architecture)
- **Vulnerabilities:** npm's bulk advisories endpoint (`POST /-/npm/v1/security/advisories/bulk`), not a spawned `npm audit` process

### Vulnerability Scope: Direct vs Transitive Dependencies
Most real-world vulnerabilities live in transitive dependencies, not the packages listed directly in `package.json`. Decision for MVP:

- The table's primary rows are **direct dependencies**.
- A direct dependency's vulnerability tag **aggregates** any advisory found anywhere in its subtree (advisories map to dependency paths, so this is derivable from the audit data without extra calls).
- Each row is expandable to show which nested package is actually flagged and the path to it.
- The **"Upgrade" button only appears if a fix exists at the direct-dependency level** (i.e. bumping the direct package resolves the transitive advisory). If no such fix exists, the tag links to advisory details instead of showing a non-functional upgrade action.

### Refresh Behavior
- Auto-runs the full check cycle (read `package.json` → fetch versions → fetch vulnerabilities) every time the panel is opened
- Manual "Refresh" button to re-run the cycle on demand
- Optional background refresh every ~30 minutes while the panel stays open (only if actively open — no polling when closed)

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
- **Data layer:** reads local `package.json` (and lockfile where relevant); all version and vulnerability data comes from the registry, sourced as detailed below.
- **Version fetching:** the npm registry has no batch endpoint for version data. Use concurrency-limited per-package requests against the abbreviated packument (`Accept: application/vnd.npm.install-v1+json`, or `/<pkg>/latest`) — the full packument for a package like `typescript` can be megabytes.
- **Vulnerability fetching:** use the real bulk endpoint (`POST /-/npm/v1/security/advisories/bulk`) instead of spawning `npm audit` as a child process.
- **Registry resolution:** read the configured registry from `.npmrc` (project-level, then user-level, then default `registry.npmjs.org`) before making requests. This does **not** include authentication (still deferred to v2/v3) — it's purely resolving the correct URL so users behind a proxy or Artifactory mirror don't get an error table on first run.

### Caching
- **Storage:** `workspaceState` (results are project-scoped, not global).
- **TTL:** ~30 minutes as a fallback ceiling.
- **Invalidation:** a file watcher on `package.json` / lockfile triggers a fresh check; manual refresh always bypasses cache.
- **Offline behavior:** if a warm cache exists, show it marked as stale rather than blocking. If the cache is cold and there's no network, show an explicit empty/error state with a retry action — never a silent blank table.

### Monorepo Handling
- Detect all `package.json` files in the workspace using VS Code's workspace search API (respects `.gitignore`), with explicit exclusions for `node_modules`, `.git`, and common build directories — avoid a raw recursive filesystem scan on large repos.
- If more than one `package.json` is found, let the user pick which one to view, or show each in its own tab.
- `workspace:*` protocol dependencies (pnpm/yarn workspaces) have no registry version to resolve — tag these as "workspace" and skip the version/vulnerability lookup rather than erroring.
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
- **Deprecated flag** — the registry response already includes this; surface it as a tag alongside the vulnerability status.
- **License field** — also included in the same registry response; useful to show per-package, especially relevant given this project is going open source itself.

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
| MVP (v1) | Core table (name, current version, available version, vulnerability tag, upgrade button), manual + auto refresh, monorepo detection, basic error handling, caching, concurrency-limited fetching |
| v1.x | Priority filter, search, dev dependency toggle |
| v2 | Dependency tree visualization, changelog viewer |
| v3 | Authentication for private registries, telemetry, versioning strategy for registry API changes |

---

## Open Questions for Later
- Exact visual design of the vulnerability tags (color scale, thresholds)
- Whether "Upgrade" applies the change directly via `npm install <pkg>@latest` or opens a confirmation step first
- Marketplace listing details (icon, extension name, description) once naming is finalized
