import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import type { ProtocolError, UpgradeTargetOptions } from '../../../src/host/webviewProtocol.js';

export type UpgradeTargetLoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; targets: UpgradeTargetOptions }
  | { phase: 'error'; error: ProtocolError }
  | { phase: 'idle' };

function optionLabel(
  option: UpgradeTargetOptions['options'][number]
): string {
  const labels = option.labels.map((label) => {
    if (label === 'recommended') return 'Recommended';
    if (label === 'lts') return 'LTS';
    return 'Latest';
  });
  return labels.length === 0 ? option.version : `${option.version} — ${labels.join(' · ')}`;
}

export function UpgradeTargetSelector({
  state,
  selectedVersion,
  fallbackVersion,
  disabled,
  onChange,
}: {
  state: UpgradeTargetLoadState;
  selectedVersion: string | null;
  fallbackVersion: string | null;
  disabled: boolean;
  onChange: (version: string) => void;
}): ReactElement {
  const [manualOpen, setManualOpen] = useState(false);
  const [manualVersion, setManualVersion] = useState('');
  const ready = state.phase === 'ready' ? state.targets : null;
  const stable = ready?.options.filter((option) => option.channel === 'stable') ?? [];
  const prerelease = ready?.options.filter((option) => option.channel === 'prerelease') ?? [];
  const usableFallback = state.phase === 'error' || state.phase === 'idle' ? fallbackVersion : null;
  const value = selectedVersion ?? ready?.recommendedVersion ?? usableFallback ?? '';
  const selectedIsCustom = value !== '' && ready !== null && !ready.options.some((option) => option.version === value);
  const manualDisabled = disabled || state.phase === 'loading';
  const applyManualVersion = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const version = manualVersion.trim();
    if (version === '') return;
    onChange(version);
    setManualOpen(false);
  };

  return (
    <section className="upgrade-target-picker" aria-labelledby="upgrade-target-picker-label">
      <div className="upgrade-target-picker__copy">
        <label className="upgrade-target-picker__label" id="upgrade-target-picker-label" htmlFor="upgrade-target-version">
          Upgrade to
        </label>
        <p className="upgrade-target-picker__hint">
          Choose the published version this review should analyze.
        </p>
      </div>
      <div className="upgrade-target-picker__control">
        <select
          className="upgrade-target-picker__select"
          id="upgrade-target-version"
          value={value}
          disabled={
            disabled ||
            state.phase === 'loading' ||
            (state.phase === 'ready' ? state.targets.options.length === 0 : value === '')
          }
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {state.phase === 'loading' ? <option value={value}>Loading published versions…</option> : null}
          {ready !== null ? (
            <>
              {selectedIsCustom ? <option value={value}>{value} — Manually entered</option> : null}
              {ready.recommendedVersion === null ? <option value="">Select a version…</option> : null}
              {stable.length > 0 ? (
                <optgroup label="Stable releases">
                  {stable.map((option) => (
                    <option value={option.version} key={option.version}>
                      {optionLabel(option)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {prerelease.length > 0 ? (
                <optgroup label="Prereleases — review carefully">
                  {prerelease.map((option) => (
                    <option value={option.version} key={option.version}>
                      {optionLabel(option)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </>
          ) : null}
          {usableFallback !== null ? (
            <option value={usableFallback}>{usableFallback} — Existing recommendation</option>
          ) : null}
        </select>
        {ready?.truncated === true ? (
          <span className="upgrade-target-picker__meta">Showing recent and tagged releases.</span>
        ) : null}
        {state.phase === 'error' ? (
          <span className="upgrade-target-picker__meta upgrade-target-picker__meta--warning" role="status">
            Published versions could not be loaded. The existing dashboard target remains available.
          </span>
        ) : null}
        <button
          type="button"
          className="button button--subtle upgrade-target-picker__manual-toggle"
          disabled={manualDisabled}
          aria-expanded={manualOpen}
          onClick={() => {
            setManualOpen((open) => !open);
            if (!manualOpen) setManualVersion(selectedIsCustom ? value : '');
          }}
        >
          {manualOpen ? 'Hide version entry' : 'Enter another version'}
        </button>
        {manualOpen ? (
          <form className="upgrade-target-picker__manual" onSubmit={applyManualVersion}>
            <label className="upgrade-target-picker__manual-label" htmlFor="upgrade-target-manual-version">
              Exact published version
            </label>
            <div className="upgrade-target-picker__manual-row">
              <input
                id="upgrade-target-manual-version"
                className="upgrade-target-picker__manual-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="For example, 15.5.9"
                value={manualVersion}
                disabled={disabled}
                onChange={(event) => setManualVersion(event.currentTarget.value)}
              />
              <button type="submit" className="button button--secondary" disabled={disabled || manualVersion.trim() === ''}>
                Use version
              </button>
            </div>
            <span className="upgrade-target-picker__meta">npm verifies this version before analysis.</span>
          </form>
        ) : null}
      </div>
    </section>
  );
}
