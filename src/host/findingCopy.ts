/**
 * A `CompatibilityFinding` → structured, renderable copy — built entirely
 * from the finding's own structured fields (`kind`, `subject`, `requirement`,
 * `observedVersion`, `relation`), never its pre-baked `explanation` sentence.
 * `explanation` stays untouched in src/core for the (unrelated) native-string
 * consumers that already exist; this is the presentation layer the Upgrade
 * Analysis modal actually renders from, matching the categorized examples in
 * the redesign spec ("⚠ Peer compatibility / some-library@4.2.0 / requires
 * react-toastify ^10").
 *
 * Each line carries its own `code` flag rather than being one pre-joined
 * prose string — a required/proposed version range is a structured field,
 * not prose, and should read distinctly (monospace) wherever it is shown;
 * see CompatibilitySection.tsx for where that rendering happens.
 */

import type { CompatibilityFinding } from './webviewProtocol.js';

export interface FindingCopyLine {
  text: string;
  /** Rendered in a monospace/code style — a version or range value, not prose. */
  code?: boolean;
}

export interface FindingCopy {
  /** Short category label — e.g. "Peer conflict", "Major update". */
  label: string;
  /** One or more lines of detail, already broken into parts for the caller to stack. */
  lines: FindingCopyLine[];
}

function versionOf(version: string | null | undefined): string {
  return version ?? 'unknown';
}

function line(text: string): FindingCopyLine {
  return { text };
}

function codeLine(text: string): FindingCopyLine {
  return { text, code: true };
}

/**
 * `context` supplies the outer analysis's own package/currentVersion so a
 * `major-version-change` finding about *that same* package can show a real
 * "current → target" line — the finding itself only carries the target
 * version (see preflight.ts's own construction of that finding kind). A
 * finding about a different package (the coordinated-plan case) falls back
 * to just the target version, which is still accurate, just less complete.
 */
export function findingCopy(
  finding: CompatibilityFinding,
  context: { package: string; currentVersion: string }
): FindingCopy {
  switch (finding.kind) {
    case 'peer-compatible':
      return {
        label: 'Peer compatibility',
        lines: [
          line(`${finding.subject.name}@${versionOf(finding.subject.version)}`),
          line(`accepts ${finding.requirement?.name}@${versionOf(finding.observedVersion)}`),
          codeLine(`Required: ${finding.requirement?.range}`),
        ],
      };
    case 'peer-incompatible':
      return {
        label: 'Peer conflict',
        lines: [
          line(`${finding.subject.name}@${versionOf(finding.subject.version)}`),
          codeLine(`Required: ${finding.requirement?.name} ${finding.requirement?.range}`),
          line(`Proposed: ${finding.requirement?.name}@${versionOf(finding.observedVersion)}`),
        ],
      };
    case 'peer-missing':
      return {
        label: 'Missing peer dependency',
        lines: [
          line(`${finding.subject.name}@${versionOf(finding.subject.version)}`),
          codeLine(`Required: ${finding.requirement?.name} ${finding.requirement?.range}`),
          line('This peer dependency is not currently resolved'),
        ],
      };
    case 'optional-peer-missing':
      return {
        label: 'Optional peer not installed',
        lines: [
          line(`${finding.subject.name}@${versionOf(finding.subject.version)}`),
          codeLine(`Optional peer: ${finding.requirement?.name} ${finding.requirement?.range}`),
        ],
      };
    case 'invalid-peer-range':
      return {
        label: 'Peer range could not be parsed',
        lines: [
          line(`${finding.subject.name}@${versionOf(finding.subject.version)}`),
          codeLine(`Invalid range for ${finding.requirement?.name}: "${finding.requirement?.range}"`),
        ],
      };
    case 'metadata-unavailable':
      return {
        label: 'Package metadata unavailable',
        lines: [line(`Peer dependency metadata for ${finding.subject.name} could not be fetched`)],
      };
    case 'graph-metadata-incomplete':
      return {
        label: 'Compatibility uncertainty',
        lines: [line("The active lockfile doesn't provide complete peer-dependency metadata")],
      };
    case 'major-version-change':
      return {
        label: 'Major update',
        lines: [
          codeLine(
            finding.subject.name === context.package
              ? `${finding.subject.name} ${context.currentVersion} → ${versionOf(finding.subject.version)}`
              : `${finding.subject.name} → ${versionOf(finding.subject.version)}`
          ),
          line('Major versions may contain breaking API changes'),
        ],
      };
  }
}
