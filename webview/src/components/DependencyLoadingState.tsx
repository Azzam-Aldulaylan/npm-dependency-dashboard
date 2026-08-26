import type { ReactElement } from 'react';
import type { ScanProgressStage } from '../../../src/host/webviewProtocol.js';

import { IconPackage } from '../icons.js';

/** Real pipeline progress when a scan stage has a meaningful item count. */
export interface LoadingProgress {
  completed: number;
  total: number;
}

const STAGE_LABELS: Record<ScanProgressStage, string> = {
  manifest: 'Reading project dependencies…',
  'dependency-graph': 'Building the dependency graph…',
  versions: 'Resolving package versions…',
  advisories: 'Checking vulnerability advisories…',
  'patched-versions': 'Resolving patched versions…',
  'npm-audit': 'Running optional npm audit enrichment…',
  rows: 'Preparing dependency rows…',
};

const RING_RADIUS = 15.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * A ring around the package glyph — spinning indeterminately by default
 * (CSS keyframes, `prefers-reduced-motion` swaps it for a static partial
 * arc in styles.css), or a real determinate arc when `progress` is
 * supplied. SVG/CSS only: no GIF, no animation library.
 */
export function LoadingRing({ progress }: { progress: LoadingProgress | undefined }): ReactElement {
  const fraction =
    progress !== undefined && progress.total > 0 ? Math.min(1, progress.completed / progress.total) : null;
  const dashoffset = fraction === null ? RING_CIRCUMFERENCE * 0.72 : RING_CIRCUMFERENCE * (1 - fraction);

  return (
    <div className="loading-ring-wrapper" aria-hidden="true">
      <svg
        className={`loading-ring${fraction === null ? ' loading-ring--indeterminate' : ''}`}
        viewBox="0 0 36 36"
        width="40"
        height="40"
      >
        <circle className="loading-ring__track" cx="18" cy="18" r={RING_RADIUS} />
        <circle
          className="loading-ring__arc"
          cx="18"
          cy="18"
          r={RING_RADIUS}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={dashoffset}
        />
      </svg>
      <IconPackage className="loading-ring__icon" />
    </div>
  );
}

/** Package-name widths vary like real ones do — a uniform skeleton reads as more obviously fake. */
const ROW_NAME_WIDTHS = ['62%', '84%', '48%', '70%', '56%', '90%'];

/**
 * A skeleton that approximates the *finished* layout — four card-shaped
 * blocks, a toolbar bar, and a table with the same four data columns real
 * rows use — rather than a handful of generic horizontal bars. The goal is
 * that swapping in real content causes as little layout shift as possible,
 * and that the shape on screen already looks like "a dependency dashboard is
 * forming", not an unrelated loading spinner.
 */
export function DependencyLoadingState({
  progress,
  stage,
}: {
  progress?: LoadingProgress | undefined;
  stage?: ScanProgressStage | undefined;
}): ReactElement {
  const detail =
    progress !== undefined
      ? `${progress.completed} of ${progress.total} analyzed`
      : stage === undefined
        ? 'Analyzing package versions and vulnerabilities…'
        : STAGE_LABELS[stage];

  return (
    <div className="loading-state" role="status" aria-live="polite">
      <div className="loading-state__intro">
        <LoadingRing progress={progress} />
        <div>
          <p className="loading-state__title">Checking dependencies</p>
          <p className="loading-state__detail">{detail}</p>
        </div>
      </div>

      <div className="loading-skeleton" aria-hidden="true">
        <div className="loading-skeleton__cards">
          {[0, 1, 2, 3].map((index) => (
            <div className="loading-skeleton__card" key={index}>
              <span className="loading-skeleton__bar loading-skeleton__bar--icon" />
              <div className="loading-skeleton__card-body">
                <span className="loading-skeleton__bar loading-skeleton__bar--label" />
                <span className="loading-skeleton__bar loading-skeleton__bar--count" />
                <span className="loading-skeleton__bar loading-skeleton__bar--subtitle" />
              </div>
            </div>
          ))}
        </div>

        <div className="loading-skeleton__toolbar">
          <span className="loading-skeleton__bar loading-skeleton__bar--toolbar-count" />
          <span className="loading-skeleton__bar loading-skeleton__bar--toolbar-action" />
        </div>

        <div className="loading-skeleton__table">
          <div className="loading-skeleton__table-header">
            <span className="loading-skeleton__bar loading-skeleton__bar--col-header" />
            <span className="loading-skeleton__bar loading-skeleton__bar--col-header" />
            <span className="loading-skeleton__bar loading-skeleton__bar--col-header" />
            <span className="loading-skeleton__bar loading-skeleton__bar--col-header" />
          </div>
          {ROW_NAME_WIDTHS.map((width, index) => (
            <div className="loading-skeleton__row" key={index}>
              <span className="loading-skeleton__bar loading-skeleton__bar--name" style={{ width }} />
              <span className="loading-skeleton__bar loading-skeleton__bar--cell" />
              <span className="loading-skeleton__bar loading-skeleton__bar--cell" />
              <span className="loading-skeleton__bar loading-skeleton__bar--badge" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
