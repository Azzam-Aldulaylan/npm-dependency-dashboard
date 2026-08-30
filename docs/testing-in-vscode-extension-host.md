# Testing the Extension in VS Code

This guide is for contributors and coding agents who need to run Dependency Dashboard against a real npm or pnpm project of their choice. The extension repository and the project being inspected remain separate.

## Requirements

- VS Code Desktop 1.90 or newer
- Node.js 20 or newer and npm
- A trusted target project containing a `package.json`
- For complete results, the target project should also have a supported lockfile: `package-lock.json`, `npm-shrinkwrap.json`, or `pnpm-lock.yaml`

Do not use a project containing sensitive dependencies or registry credentials unless the test requires it. The development extension can read the target project's `.npmrc`, query package registries, and run package-manager commands after user confirmation.

## One-time setup

Open the **extension repository**, not the target project, as the main VS Code workspace. Then install and verify its dependencies:

```bash
npm ci
npm run typecheck
npm test
```

Create `.vscode/launch.json` in the extension repository with the following local configuration:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Dependency Dashboard against a project",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}",
        "${input:targetProjectPath}"
      ],
      "outFiles": [
        "${workspaceFolder}/dist/**/*.js"
      ],
      "preLaunchTask": "npm: build"
    }
  ],
  "inputs": [
    {
      "id": "targetProjectPath",
      "type": "promptString",
      "description": "Absolute path to the npm or pnpm project to inspect",
      "default": "/absolute/path/to/your/project"
    }
  ]
}
```

The repository ignores `.vscode/`, so this machine-specific setup will not be committed. Always use an absolute target-project path. Paths containing spaces work without extra quoting in this JSON array.

## Run against a chosen project

1. In the extension repository's VS Code window, open **Run and Debug**.
2. Select **Run Dependency Dashboard against a project**.
3. Press `F5` and enter the absolute path to the target project.
4. A separate **Extension Development Host** window opens at that project.
5. Trust the target workspace if VS Code asks. The extension intentionally stays disabled in untrusted workspaces.
6. In the development-host window, open the Command Palette and run **Dependency Dashboard: Open**.
7. If the workspace contains multiple `package.json` files, select the intended project in the dashboard's project picker.

The launch task builds the extension before every run. After source changes, stop the current debugging session and press `F5` again to guarantee that both the extension host and webview use the latest bundle.

## What to verify

Use a disposable branch or a copy of the target project when testing actions that can change dependencies.

- Confirm the correct project and package manager are selected.
- Refresh and verify current, wanted, and latest package versions.
- Expand vulnerability rows and test public CVE/GHSA links.
- Exercise Manage Dependency, Upgrade Review, Removal Review, bulk maintenance, and Smart Cleanup as relevant.
- Before approving an upgrade or cleanup, inspect the proposed manifest and lockfile changes.
- After any mutation, inspect `git diff` in the target project and restore or discard test-only changes there.

## Debugging and logs

- Extension-host logs and uncaught errors appear in the original VS Code window's **Debug Console**.
- Webview logs appear from **Developer: Open Webview Developer Tools** in the Extension Development Host.
- Enable `dependencyDashboard.debug.performance` in the target workspace settings when performance timing is needed. Disable it after the investigation.
- Use **Developer: Reload Window** in the Extension Development Host only for a quick UI retry. Restart the `F5` session after code changes so the extension bundle is rebuilt.

## Finishing a test run

1. Close the Extension Development Host or stop debugging in the original window.
2. Check the target project's `git status` and retain only intentional test changes.
3. In the extension repository, run:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Do not commit generated `dist/` output, local `.vscode/` files, target-project changes, registry credentials, or temporary test data.

## Common problems

- **The command is missing:** confirm the target workspace contains a `package.json`, is trusted, and the new window title includes **Extension Development Host**.
- **The wrong project appears:** use the dashboard's project picker, or relaunch with a narrower target folder.
- **Results look stale:** run **Dependency Dashboard: Refresh**. Restart the debugging session after changing extension code.
- **The build task cannot find Node:** start VS Code from a shell where `node` and `npm` work, or configure VS Code to use the intended Node installation.
- **A package action changed the target project:** inspect that project's manifest and lockfile with `git diff`; restore them from the target project's own version control when the change was only for testing.
