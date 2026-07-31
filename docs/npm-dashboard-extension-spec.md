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
- **Available updates:** npm registry API
- **Vulnerabilities:** `npm audit` (or equivalent registry vulnerability data)

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
- **Data layer:**
  - Read local `package.json` (and lockfile where relevant)
  - Call npm registry API for version data
  - Call `npm audit` (or registry vulnerability endpoint) for security data
- **Caching:** cache registry/vulnerability responses locally to avoid re-fetching on every small UI interaction; only hit the network on refresh cycles
- **Batching:** batch version/vulnerability requests instead of firing one request per package, to keep things fast on large dependency lists

### Monorepo Handling
- Detect all `package.json` files in the workspace
- If more than one is found, let the user pick which one to view, or show each in its own tab
- No forced single-project assumption

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

## Business Context

- **Primary use case:** personal projects first (including React / Next.js codebases)
- **Distribution:** planned publish to the VS Code Marketplace
- **Repo:** public and open source — allows community trust, bug reports, and contributions

---

## Roadmap Summary

| Phase | Scope |
|---|---|
| MVP (v1) | Core table (name, current version, available version, vulnerability tag, upgrade button), manual + auto refresh, monorepo detection, basic error handling, caching/batching |
| v1.x | Priority filter, search, dev dependency toggle |
| v2 | Dependency tree visualization, changelog viewer |
| v3 | Authentication for private registries, telemetry, versioning strategy for registry API changes |

---

## Open Questions for Later
- Exact visual design of the vulnerability tags (color scale, thresholds)
- Whether "Upgrade" applies the change directly via `npm install <pkg>@latest` or opens a confirmation step first
- Marketplace listing details (icon, extension name, description) once naming is finalized
