/**
 * The host bridge VS Code injects into the webview's global scope.
 *
 * `acquireVsCodeApi` may only be called once per webview load — calling it
 * twice throws — so it is called here and the result shared as a module
 * singleton.
 *
 * The protocol import is `import type`, which esbuild erases entirely. Nothing
 * from the extension host reaches this bundle through it.
 */

import type { WebviewToHostMessage } from '../../src/host/webviewProtocol.js';

export interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  function acquireVsCodeApi(): VsCodeApi;
}

export const vscode: VsCodeApi = acquireVsCodeApi();
