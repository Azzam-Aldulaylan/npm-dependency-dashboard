/**
 * The minimal shape this cache layer needs from a persistence backend —
 * satisfied structurally by `vscode.Memento` (`context.workspaceState`/
 * `context.globalState`) without importing `vscode` at all: `get` is
 * synchronous on a real Memento, and `update`'s `Thenable<void>` is
 * `PromiseLike<void>`-compatible. That keeps every file in this directory
 * testable with a plain fake object and zero extension-host dependency,
 * even though the real caller (src/host/dashboardPanel.ts) is VS Code.
 */
export interface KeyValueStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}
