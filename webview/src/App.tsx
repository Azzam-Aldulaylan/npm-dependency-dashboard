import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { dependencyCountLabel } from '../../src/host/dependencySummary.js';
import { upgradeErrorClearsActiveState, upgradeErrorIsUserVisible } from '../../src/host/upgradeUiState.js';
import type { DashboardData, HostToWebviewMessage } from '../../src/host/webviewProtocol.js';
import { isHostToWebviewMessage } from '../../src/host/webviewProtocol.js';
import { PackageTable } from './components/PackageTable.js';
import { RefreshButton } from './components/RefreshButton.js';
import { vscode } from './vscodeApi.js';

function formatTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
}

function partialErrorText(data: DashboardData): string | null {
  const reasons: string[] = [];
  if (data.advisoriesError !== undefined) {
    reasons.push(`vulnerability data is unavailable (${data.advisoriesError.code})`);
  }
  if (data.auditUnavailable === true) {
    reasons.push('npm audit could not run, so upgrade targets are self-computed');
  }
  return reasons.length === 0 ? null : reasons.join('; ');
}

interface UpgradeErrorState {
  package: string;
  code: string;
  message: string;
}

export function App(): ReactElement {
  const [message, setMessage] = useState<HostToWebviewMessage | undefined>(undefined);
  // The one package this webview itself most recently asked to upgrade, or
  // null. The host allows only one upgrade at a time for the whole panel —
  // see UpgradeLock — so this mirrors that as a single value, not a set, and
  // disables every Upgrade button (not just the one clicked) while set.
  const [activeUpgrade, setActiveUpgrade] = useState<string | null>(null);
  const [upgradeError, setUpgradeError] = useState<UpgradeErrorState | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      // The webview is its own security context and `message` events are not
      // exclusively ours. Anything that does not match the protocol exactly is
      // dropped rather than partially trusted.
      if (!isHostToWebviewMessage(event.data)) {
        console.warn('Dependency Dashboard: dropped a message that failed validation');
        return;
      }
      const incoming = event.data;

      if (incoming.status === 'upgrade-error') {
        // Never touches `message` — the rendered table/banners are exactly
        // what they were before this arrived.
        if (upgradeErrorClearsActiveState(incoming.error.code)) {
          setActiveUpgrade(null);
        }
        if (upgradeErrorIsUserVisible(incoming.error.code)) {
          setUpgradeError({ package: incoming.package, code: incoming.error.code, message: incoming.error.message });
        }
        return;
      }

      // Any other message is a fresh snapshot that supersedes whatever
      // optimistic upgrade state was showing.
      setActiveUpgrade(null);
      setUpgradeError(null);
      setMessage(incoming);
    };

    // Listen before announcing readiness, so the host's reply cannot be missed.
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, []);

  const refresh = useCallback(() => {
    vscode.postMessage({ type: 'refresh' });
  }, []);

  const changeProject = useCallback(() => {
    vscode.postMessage({ type: 'change-project' });
  }, []);

  const requestUpgrade = useCallback((packageName: string, target: string) => {
    setActiveUpgrade(packageName);
    vscode.postMessage({ type: 'upgrade', package: packageName, target });
  }, []);

  // No message yet is the same user-visible state as an explicit loading one.
  const loading = message === undefined || message.status === 'loading';
  const data = message !== undefined && 'data' in message ? message.data : undefined;
  // Disabled while an upgrade is active — a manual refresh or project switch
  // mid-upgrade would race the scan (and, for a project switch, a controller
  // replacement) against a package.json/lockfile the task is still writing
  // to; the host rejects both too (see DashboardPanel.handle), this just
  // keeps the buttons from inviting a click that can't do anything anyway.
  const actionsDisabled = loading || activeUpgrade !== null;

  return (
    <main className="dashboard">
      <header className="dashboard__header">
        <div className="dashboard__header-titles">
          <h1 className="dashboard__title">Dependencies</h1>
          {data !== undefined ? <p className="dashboard__project">{data.project.label}</p> : null}
        </div>
        <div className="dashboard__header-actions">
          {data !== undefined && data.canChangeProject ? (
            <button
              className="button"
              type="button"
              onClick={changeProject}
              disabled={actionsDisabled}
            >
              Change project
            </button>
          ) : null}
          <RefreshButton onRefresh={refresh} disabled={actionsDisabled} />
        </div>
      </header>

      {loading ? <p className="notice">Checking dependencies…</p> : null}

      {message !== undefined && message.status === 'fatal-error' ? (
        <div className="banner banner--error" role="alert">
          <p className="banner__text">{message.error.message}</p>
          <button className="button" type="button" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      {/* upgradeError is only ever set for a user-visible code (see
          upgradeErrorIsUserVisible) — CANCELLED and UPGRADE_IN_PROGRESS never
          reach this state at all, so there is nothing to filter here. */}
      {upgradeError !== null ? (
        <div className="banner banner--error" role="alert">
          <p className="banner__text">
            Couldn't upgrade {upgradeError.package}: {upgradeError.message}
          </p>
        </div>
      ) : null}

      {message !== undefined && 'data' in message ? (
        <Dashboard
          status={message.status}
          data={message.data}
          activeUpgrade={activeUpgrade}
          onUpgrade={requestUpgrade}
        />
      ) : null}
    </main>
  );
}

function Dashboard({
  status,
  data,
  activeUpgrade,
  onUpgrade,
}: {
  status: 'empty' | 'ready' | 'stale' | 'partial-error';
  data: DashboardData;
  activeUpgrade: string | null;
  onUpgrade: (packageName: string, target: string) => void;
}): ReactElement {
  const degraded = status === 'partial-error' ? partialErrorText(data) : null;

  return (
    <>
      {status === 'stale' ? (
        <p className="banner banner--warning">
          Showing results from {formatTime(data.generatedAt)}, which may be out of date. Checking
          again…
        </p>
      ) : null}

      {/* A degraded slice of the data still renders the table — hiding every
          column because one is missing is worse than showing what we have. */}
      {degraded === null ? null : (
        <p className="banner banner--warning">Showing partial results: {degraded}.</p>
      )}

      {status === 'empty' ? (
        <p className="notice">No dependencies found.</p>
      ) : (
        <PackageTable rows={data.rows} activeUpgrade={activeUpgrade} onUpgrade={onUpgrade} />
      )}

      <p className="dashboard__footer">
        {dependencyCountLabel(data.rows.length)} • Updated {formatTime(data.generatedAt)}
      </p>
    </>
  );
}
