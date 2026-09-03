# Contributing

Thanks for helping improve Dependency Dashboard. Bug reports, focused feature
proposals, documentation improvements, and tested pull requests are welcome.

## Development setup

Requirements: VS Code Desktop 1.90 or newer and Node.js 22 or newer.

```bash
git clone https://github.com/Azzam-Aldulaylan/npm-dependency-dashboard.git
cd npm-dependency-dashboard
npm ci
npm run typecheck
npm test
```

Use [Testing the Extension in VS Code](docs/testing-in-vscode-extension-host.md)
to run the extension against a disposable or local npm/pnpm project.

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run test:real-projects
npm run test:extension-host
npm run build
git diff --check
```

- Keep the extension composition root small; place reusable domain behavior in
  `src/core`, VS Code-facing coordination in `src/host`, and UI in `webview/src`.
- Reuse existing UI components and VS Code theme variables before adding new
  one-off styles.
- Add focused regression coverage for every behavior change.
- Do not commit `dist`, VSIX packages, credentials, temporary projects, local
  `.vscode` configuration, or agent/runtime state.
- Describe user-visible behavior, safety implications, and the npm/pnpm paths
  tested in the pull request.

Dependency mutations and live registry tests require network access and can run
package-manager commands. Use disposable projects unless the change specifically
requires a real application fixture.

## Reporting security issues

Do not disclose a suspected vulnerability in a public issue. Follow
[SECURITY.md](SECURITY.md) instead.
