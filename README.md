# npm Dependency Dashboard

A lightweight VS Code extension that shows all npm packages installed in your project — React, Next.js, or any Node-based repo — in a single in-editor dashboard.

No more jumping to the terminal for `npm outdated` and `npm audit`. See package name, current version, available update, and vulnerability status (color-coded) in one panel, with a one-click upgrade action.

## Status
Early planning stage. See [`docs/npm-dashboard-extension-spec.md`](docs/npm-dashboard-extension-spec.md) for the full spec: features, architecture, roadmap, and open questions.

## Highlights
- Table view: package name, current version, available version, vulnerability tag, upgrade button
- Manual + automatic refresh (on open, and periodically while the panel is active)
- Monorepo support (multiple `package.json` files, npm only for MVP)
- Built to stay slim, fast, and low on resources

## Planned Stack
- TypeScript, VS Code Extension API
- React-based Webview UI
- npm registry API for versions, `npm audit` for vulnerability data

## Roadmap
1. **MVP** — core table, refresh, monorepo detection, error handling, caching (npm only)
2. **v1.x** — priority filter, search, dev dependency toggle
3. **v2** — dependency tree visualization, changelog viewer
4. **v3** — pnpm/yarn support, private registry auth, telemetry, versioning strategy

## License
Open source. LICENSE file is an MVP blocker (required for Marketplace publishing) — specific license to be chosen before v1 ships.

## Contributing
Not yet open for contributions while the spec and initial implementation are being worked out. Issues and discussion are welcome.
