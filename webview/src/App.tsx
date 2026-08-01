import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

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

export function App(): ReactElement {
  const [message, setMessage] = useState<HostToWebviewMessage | undefined>(undefined);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      // The webview is its own security context and `message` events are not
      // exclusively ours. Anything that does not match the protocol exactly is
      // dropped rather than partially trusted.
      if (!isHostToWebviewMessage(event.data)) {
        console.warn('Dependency Dashboard: dropped a message that failed validation');
        return;
      }
      setMessage(event.data);
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

  // No message yet is the same user-visible state as an explicit loading one.
  const loading = message === undefined || message.status === 'loading';

  return (
    <main className="dashboard">
      <header className="dashboard__header">
        <h1 className="dashboard__title">Dependencies</h1>
        <RefreshButton onRefresh={refresh} disabled={loading} />
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

      {message !== undefined && 'data' in message ? (
        <Dashboard status={message.status} data={message.data} />
      ) : null}
    </main>
  );
}

function Dashboard({
  status,
  data,
}: {
  status: 'empty' | 'ready' | 'stale' | 'partial-error';
  data: DashboardData;
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
        <PackageTable rows={data.rows} />
      )}
    </>
  );
}
