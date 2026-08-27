# npm Dependency Dashboard

A VS Code extension that shows every direct npm dependency of your project — package name, current/wanted/latest version, and known vulnerabilities — in a single in-editor panel, with a one-click upgrade action. No more jumping to the terminal for `npm outdated` and `npm audit`.

Supports npm and pnpm projects. Yarn and private-registry authentication beyond the package manager's own configuration remain out of scope (see [Known limitations](#known-limitations)).

## What it does

Opening the dashboard scans the selected project's `package.json` (and lockfile, if present) and renders a table with one row per **direct** dependency:

- **Package** — name, with a "Dev" badge for `devDependencies`.
- **Current** — the version actually installed, from the lockfile. If there's no lockfile, this shows the declared range instead, tagged as `workspace`, `file:`, `git`, `alias`, `tarball`, or `unresolved`, depending on why a lockfile version can't be shown.
- **Wanted / Latest** — see [Current, Wanted, and Latest](#current-wanted-and-latest).
- **Vulnerabilities** — a severity badge; click a row to expand full advisory details, including which transitive package is actually flagged and the dependency path down to it.
- **Action** — an Upgrade button when a newer version is available.

## Installation

1. Install the extension from the VS Code Marketplace (search "Dependency Dashboard") — see [Publisher and Marketplace status](#publisher-and-marketplace-status) below for current availability.
2. Open a workspace that contains a `package.json`. The extension activates automatically at that point, but activating does not open anything by itself.
3. Run **Dependency Dashboard: Open** from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) to open the panel.
4. If the workspace has more than one `package.json` (a monorepo), you'll be asked to pick a project — see [Monorepo support](#monorepo-and-project-picker-support).

Use **Dependency Dashboard: Refresh** to force a re-scan at any time.

## Current, Wanted, and Latest

These follow the same meaning as `npm outdated`:

- **Current** — version installed according to the lockfile.
- **Wanted** — newest version allowed by the range in `package.json`.
- **Latest** — newest stable version published to npm.

## Vulnerability severities

Each advisory is one of `Critical`, `High`, `Moderate`, `Low`, or `Info`. A package with no known advisory shows `Safe`. A row's badge reflects the worst severity found anywhere in that direct dependency's subtree; expanding the row lists every individual advisory found, the transitive package it actually applies to, and the dependency path from the direct dependency down to it.

Vulnerability data comes primarily from npm's bulk advisories endpoint (see [Privacy and network access](#privacy-and-network-access)), which is faster and doesn't require a subprocess. `npm audit --json` is used only as optional enrichment, to determine which advisories already have a resolvable fix available by bumping a direct dependency — if it's unavailable, slow, or fails to parse, the dashboard degrades gracefully rather than failing.

## Upgrading a package

Clicking Upgrade on a row now runs a safe-assistant lifecycle:

1. Runs an on-demand compatibility preflight over peer dependencies, optional/missing peers, relevant graph paths, package-manager peer policy, exact target metadata, and—when a secure package-manager invocation is available—an isolated resolver check in a temporary project.
2. When a peer conflict is found, performs a bounded search for a coordinated direct-dependency upgrade plan. Plans can span production, development, and optional dependencies while preserving each package's existing manifest classification.
3. Shows a modal confirmation naming the requested and coordinated changes, compatibility findings, lifecycle-script policy, and configured verification scripts.
4. Re-reads the project and repeats host-side eligibility validation after the modal, then snapshots `package.json` and the active npm/pnpm lockfile. Mixed-classification plans stage exact, host-generated manifest changes through compare-and-swap protection.
5. Runs one visible VS Code Task with structured arguments: a classified `npm install`/`pnpm add` for ordinary plans, or a bare manifest-reconciliation install for mixed-classification plans.
6. Runs only verification scripts explicitly listed in `dependencyDashboard.upgrade.verificationScripts`. No application scripts run by default, and install success alone is reported as unverified.
7. On install failure, or when the user chooses Rollback after failed verification, restores only the transaction-owned files. Rollback refuses to overwrite concurrent edits.

Only one upgrade can run at a time per panel; Refresh and further upgrades are blocked while one is in flight.

### `--ignore-scripts`

The `dependencyDashboard.upgrade.ignoreScripts` setting (**default: `true`**) controls whether `--ignore-scripts` is passed to the upgrade's `npm install` call. With the default on, package lifecycle scripts (`postinstall`, etc.) do not run as part of an upgrade triggered from the dashboard. Turn it off if you need lifecycle scripts to run during an upgrade.

## Workspace Trust

This extension reads a workspace-controlled `.npmrc` (sensitive — a workspace could point it at an arbitrary registry or embed a credential-affecting setting) and can run `npm install` with the workspace's own lifecycle scripts (which is what can actually execute code from the workspace, not the `.npmrc` read itself). It declares `untrustedWorkspaces.supported: false`, so **VS Code will not activate it at all in an untrusted workspace**. Trust is also re-checked at two further points as defense in depth: before reading a project's own `.npmrc`, and immediately before running any upgrade task.

## Monorepo and project picker support

If a workspace contains more than one `package.json` (excluding `node_modules`, `.git`, `dist`, `out`, `build`, `coverage`, `.next`, `.nuxt`, `.svelte-kit`, `.cache`, `vendor`, and `tmp`), the dashboard prompts you to pick which project to view, labelled by workspace folder (and sub-directory, for nested projects). A "Change Project" action lets you switch later.

For npm and pnpm workspaces, each member resolves the nearest supported ancestor lockfile. pnpm v9 importers and `workspace:`/`link:` entries are recognized; linked workspace packages remain displayed as workspace links rather than registry-resolved packages.

## Cache and refresh behavior

- **`dependencyDashboard.cacheTtlMinutes`** (default `30`, minimum `0`) controls how long a cached scan is considered fresh before the dashboard automatically rescans. `0` means always revalidate on open.
- Opening the dashboard with a warm, non-expired cache renders instantly with no network call. A stale cache renders instantly too, while a revalidation runs underneath. A cold cache runs the full fetch.
- Independently of the TTL setting, a background timer checks every 30 minutes (while the panel is open) whether a refresh is due, and runs one if so — this is a fixed interval, separate from the (also currently 30-minute-default) TTL setting.
- Manual refresh (command or button) always bypasses the cache and re-reads from disk.
- The extension watches the project's `package.json` and supported lockfile topology (`package-lock.json`, `npm-shrinkwrap.json`, and `pnpm-lock.yaml`) and reloads automatically when they change outside the dashboard.
- Cache data is stored using VS Code's own extension storage: project scan results are workspace-scoped; registry version-lookup ETags (public package metadata only, never project-specific) are shared across workspaces. Nothing is written anywhere outside VS Code's extension storage.

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `dependencyDashboard.registry.useProjectNpmrc` | boolean | `true` | Read the registry from the project's `.npmrc`. Values containing `${` are always rejected. Turn this off to use only your user-level `.npmrc`. |
| `dependencyDashboard.upgrade.ignoreScripts` | boolean | `true` | Pass `--ignore-scripts` when upgrading, so package lifecycle scripts don't run. |
| `dependencyDashboard.upgrade.verificationScripts` | string[] | `[]` | Existing package.json script names to run explicitly after installation. Empty means the application upgrade remains unverified. |
| `dependencyDashboard.cacheTtlMinutes` | number | `30` (minimum `0`) | How long cached dependency data stays fresh before it's rescanned, in minutes. `0` means always revalidate. |

## Privacy and network access

**No telemetry, analytics, or tracking of any kind.** The extension talks only to npm registry infrastructure, on your behalf, for the sole purpose of showing you dependency and vulnerability data:

- `GET https://registry.npmjs.org/<package>/latest` and, when needed, the full package metadata — or whichever registry your resolved `.npmrc` points to instead, if `dependencyDashboard.registry.useProjectNpmrc` is enabled.
- `POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk` for vulnerability data — always npm's own advisory host, regardless of which registry is otherwise configured, since private registry mirrors generally don't implement this endpoint.
- A locally spawned `npm audit --json --package-lock-only --registry=https://registry.npmjs.org/` for optional vulnerability-fix enrichment — also always pinned to npm's own registry host, not your configured one.
- An isolated npm/pnpm resolution check when an upgrade is considered, with scripts disabled and a temporary directory as its working project.
- A locally spawned `npm install` or `pnpm add` after confirmation, which talks to the registry resolved by the package manager's own configuration.

The dashboard's webview has no network access of its own (`default-src 'none'`, no inline scripts); all network activity happens in the extension host, never in the webview. All version/vulnerability data returned is public npm registry metadata about packages you already declared a dependency on — nothing about you or your source code is ever sent anywhere.

## Development

```bash
npm install
npm run watch      # esbuild in watch mode
npm run typecheck  # tsc --noEmit across the extension host, core, and webview
npm test           # node:test — fast, offline, no network access
npm run test:live  # optional: hits the real npm advisories endpoint over the network
npm run build                    # development bundle
npm run build -- --production    # minified production bundle, no sourcemaps
```

### Packaging a VSIX

```bash
npm run package    # runs vscode:prepublish (a production build) automatically, then vsce package
```

`@vscode/vsce` is a pinned devDependency, so packaging doesn't depend on any global tool.

## Known limitations

- Yarn is not supported.
- pnpm lockfile support currently targets lockfile format v9. Catalog/alias protocols and pnpm-specific audit enrichment are not yet supported; bulk advisory attribution still works over the normalized pnpm graph.
- Workspace-linked packages are identified but their member manifests are not traversed as registry packages during compatibility analysis.
- Private-registry authentication is left to the package manager; the extension never reads or persists auth keys.
- The table is direct-dependency-level: transitive vulnerabilities are attributed to the direct dependency that pulls them in, not listed as their own rows.
- Container images, operating-system packages, and globally installed npm tooling are not scanned. A separate, opt-in design is recorded in [Future container and runtime vulnerability scanning](docs/future-container-runtime-vulnerability-scanning.md).
- No dependency-tree visualization or changelog viewer yet.
- Desktop-only: the extension spawns local `npm`/Node processes and hasn't been tested in vscode.dev or other web-extension contexts.

## Publisher and Marketplace status

This extension has not yet been published to the VS Code Marketplace. Publishing requires a registered Marketplace publisher ID (any publisher account) — the Marketplace's separate "verified" badge (domain ownership verification) is optional and not a prerequisite for a first publication.

The manifest sets `"preview": true`, which shows a "Preview" badge on the listing once published. That is independent of, and not the same as, VS Code's separate pre-release release channel (`vsce publish --pre-release`), which requires users to explicitly opt in to pre-release updates and was not used for this release.

## License

[MIT](LICENSE)
