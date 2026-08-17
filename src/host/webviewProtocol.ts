/**
 * The postMessage contract between the extension host and the webview.
 *
 * Two hard constraints on this file:
 *
 *  1. **No `vscode` import, ever.** The webview bundle imports the guards below
 *     as real runtime values, and it runs in a browser context where the
 *     `vscode` module does not exist. Adding an import here would pull the
 *     extension host API into the browser bundle and break it at load time.
 *  2. **Everything crossing the boundary is plain JSON.** postMessage
 *     structured-clones its payload, so class instances arrive as bare objects
 *     with their prototype stripped — a `FetchError` would lose `.retryable`
 *     and its `instanceof` identity. Errors are therefore flattened to
 *     `{ code, message }` before they get here (see dashboardData.ts), which
 *     also keeps error internals from leaking into the UI layer.
 *
 * Both sides validate with the guards below before acting on a message. The
 * webview is a separate security context; a message arriving on `window` is
 * not necessarily one we sent.
 */

import type { Advisory, AttributedAdvisory, PackageRow, PatchedVersionResult } from '../core/types.js';
import type { DependencyFinding } from '../core/hygiene/types.js';
import type { DependencyReference, DependencyUsageResult } from '../core/usage/types.js';
import {
  isAbsentOr,
  isAdvisory,
  isAttributedAdvisory,
  isDependencyFinding,
  isPackageRow,
  isPatchedVersionResult,
  isProtocolError,
  isRecord,
} from '../core/validation.js';
import type { ProtocolError } from '../core/validation.js';

/**
 * The wire shapes below (`CompatibilityFinding`, `ResolverVerification`,
 * `SecurityOutcome`, `UpgradeAnalysisPresentation`, ...) are deliberately
 * declared here rather than imported from their core/host equivalents
 * (src/core/compatibility/types.ts, src/core/advisories/securityOutcome.ts,
 * src/host/upgradeAnalysisPresentation.ts). Those modules are reachable
 * (transitively, via `import type`) from src/core/registry/versions.ts,
 * which does a real *value* import of src/core/registry/http.ts — Node-only
 * code (node:https, Buffer, ...) with no types under the webview's DOM-only
 * tsconfig. `import type` does not prevent tsc from adding that whole file
 * to the program for type-checking, so importing any of those types here
 * would break the webview typecheck even though nothing at runtime would
 * actually execute. Declaring independent, structurally-identical wire types
 * keeps this file's "no Node-reachable import" constraint honest; host code
 * that builds an UpgradeAnalysisPresentation (upgradeAnalysisPresentation.ts)
 * imports these types from here instead, and TypeScript's structural typing
 * means no explicit conversion is needed since the shapes match field-for-field.
 */
export type CompatibilityStatus = 'compatible' | 'warning' | 'conflict' | 'unknown';
export type CompatibilityCompleteness = 'complete' | 'partial';
export type CompatibilityFindingKind =
  | 'peer-compatible'
  | 'peer-incompatible'
  | 'peer-missing'
  | 'optional-peer-missing'
  | 'invalid-peer-range'
  | 'metadata-unavailable'
  | 'graph-metadata-incomplete'
  | 'major-version-change';

export interface CompatibilitySubject {
  name: string;
  version: string | null;
  nodeId: string | null;
}

export interface PeerRequirement {
  name: string;
  range: string;
  optional: boolean;
}

export interface DependencyRelation {
  kind: 'direct' | 'transitive' | 'peer';
  nodeIds: string[];
  packageNames: string[];
}

export interface CompatibilityFinding {
  id: string;
  kind: CompatibilityFindingKind;
  status: CompatibilityStatus;
  source: 'static';
  subject: CompatibilitySubject;
  requirement?: PeerRequirement;
  observedVersion?: string | null;
  relation: DependencyRelation;
  explanation: string;
}

export type SupportedPackageManager = 'npm' | 'pnpm';

export interface ResolverVerification {
  status: CompatibilityStatus;
  packageManager: SupportedPackageManager;
  packageManagerVersion: string | null;
  code: string;
  explanation: string;
}

export type SecurityOutcomeStatus = 'resolved' | 'remains' | 'unknown' | 'not-applicable';

export interface RemainingVulnerability {
  advisory: Advisory;
  flaggedPackage: string;
  path: string[];
  status: 'remains' | 'unknown';
  resolvedVersion: string | null;
  patchedVersion: PatchedVersionResult;
}

export interface SecurityOutcome {
  status: SecurityOutcomeStatus;
  resolvedAdvisories: AttributedAdvisory[];
  remaining: RemainingVulnerability[];
}

export type DependencyClassification = 'prod' | 'dev' | 'optional';

/**
 * The result of a "Analyze remediation" run for one transitive vulnerability
 * — see resolveRemediationRequest (src/core/advisories/remediationRequest.ts)
 * and handleAnalyzeRemediation (upgradeAssistantCoordinator.ts). Reuses
 * `SecurityOutcomeStatus`'s own vocabulary rather than inventing another;
 * `'not-applicable'` never appears here since this flow only ever runs for a
 * row that already has attributed advisories.
 */
export type RemediationOutcomeStatus = 'resolved' | 'remains' | 'unknown';

export interface RemediationResult {
  status: RemediationOutcomeStatus;
  /** Full before/after detail — reused as-is so the UI never has to construct its own explanation of what changed. */
  security: SecurityOutcome;
}

/**
 * The on-demand usage-analysis result for one package, plus the opaque
 * `usageId` future `open-usage-reference` requests must present — see
 * src/host/usage/usageReferenceStore.ts for the trust boundary this exists
 * for. `result.references` carry a display-only `filePath`/`line`/`column`;
 * the actual "Open file" action never trusts those directly (see
 * `open-usage-reference` below).
 */
export interface UsageAnalysisResult {
  usageId: string;
  result: DependencyUsageResult;
}

export interface UpgradeAnalysisSmartPlanChange {
  packageName: string;
  currentVersion: string;
  targetVersion: string;
}

export interface UpgradeAnalysisSmartPlan {
  changes: UpgradeAnalysisSmartPlanChange[];
  reasonFindingIds: string[];
}

export type UpgradeAnalysisVerification =
  | { configured: true; scriptNames: string[] }
  | { configured: false };

export interface UpgradeAnalysisFiles {
  manifestPath: string;
  lockfilePath: string;
  rollbackAvailable: boolean;
}

export interface UpgradeAnalysisCompatibility {
  status: CompatibilityStatus;
  completeness: CompatibilityCompleteness;
  findings: CompatibilityFinding[];
  resolverVerification?: ResolverVerification;
}

export interface UpgradeAnalysisPresentation {
  analysisId: string;
  package: string;
  currentVersion: string;
  targetVersion: string;
  classification: DependencyClassification;
  majorUpdate: boolean;
  compatibility: UpgradeAnalysisCompatibility;
  security: SecurityOutcome | null;
  smartPlan: UpgradeAnalysisSmartPlan | null;
  verification: UpgradeAnalysisVerification;
  files: UpgradeAnalysisFiles;
}

// Re-exported for every existing import site (dashboardController.ts,
// dashboardPanel.ts, upgradeRunner.ts, etc.) that imports `ProtocolError`
// from here rather than its new home in src/core/validation.ts — the wire
// protocol's error shape and the persisted-cache error shape are the same
// type, defined once in core so both boundaries share it.
export type { ProtocolError };

/**
 * S6 — the currently selected project. Only ever a display `label` plus a
 * workspace-folder-relative `manifestPath` — never an absolute filesystem
 * path, and never anything beyond what the webview already needs to render.
 */
export interface SelectedProjectInfo {
  /** Workspace-folder name, plus the containing directory when not the folder root — see projectCandidateLabel. */
  label: string;
  /** Workspace-folder-relative POSIX path to package.json. */
  manifestPath: string;
}

/** Everything the table needs to render, JSON-safe end to end. */
export interface DashboardData {
  rows: PackageRow[];
  /** ISO timestamp of the run that produced these rows. */
  generatedAt: string;
  project: SelectedProjectInfo;
  /** More than one project candidate was discovered — gates whether "Change project" renders at all. */
  canChangeProject: boolean;
  /** The bulk advisory fetch failed; rows render without vulnerability data. */
  advisoriesError?: ProtocolError;
  /** `npm audit` enrichment was skipped or failed; upgrade targets are self-computed. */
  auditUnavailable?: boolean;
  /** Deprecated + duplicate-version findings, computed fresh with every scan — see src/core/hygiene/index.ts. Likely-unused findings are never included here; see 'cleanup-result' below. */
  hygieneFindings: DependencyFinding[];
}

export type HostToWebviewMessage =
  | { status: 'loading' }
  | { status: 'empty'; data: DashboardData }
  | { status: 'ready'; data: DashboardData }
  | { status: 'stale'; data: DashboardData }
  | { status: 'partial-error'; data: DashboardData }
  | { status: 'fatal-error'; error: ProtocolError }
  /**
   * A specific package's upgrade could not run — rejected by host-side
   * validation, cancelled at the confirmation step, or the task itself
   * failed. Deliberately does not carry `data`: the existing table is never
   * touched by this message, only the requesting row's own "running" state.
   */
  | { status: 'upgrade-error'; package: string; error: ProtocolError }
  /**
   * One of the (at most two) genuinely-observable analysis phases has
   * started — never a fabricated progress step. See spec §20.
   */
  | { status: 'upgrade-analyzing'; package: string; phase: 'compatibility' | 'smart-plan' }
  /** The host-owned Upgrade Analysis, ready for the modal to render. */
  | { status: 'upgrade-analysis'; analysis: UpgradeAnalysisPresentation }
  /** A transitive-vulnerability "Analyze remediation" request has started — see analyze-remediation below. */
  | { status: 'remediation-analyzing'; package: string }
  /** The host-owned remediation analysis result for `package`, ready for the Action cell to render. */
  | { status: 'remediation-result'; package: string; result: RemediationResult }
  /** `package` could not be analyzed — an ineligible/forged request, a stale project snapshot, or a resolver failure that still deserves a user-visible reason rather than silently falling back to "unknown". */
  | { status: 'remediation-error'; package: string; error: ProtocolError }
  /** "Where is this used?" (or the per-package half of an "Analyze cleanup" run) has started for `package`. */
  | { status: 'usage-analyzing'; package: string }
  /** The host-owned usage-analysis result for `package`, ready to render as a reference list. */
  | { status: 'usage-result'; package: string; analysis: UsageAnalysisResult }
  /** `package`'s usage analysis failed or was cancelled. */
  | { status: 'usage-error'; package: string; error: ProtocolError }
  /** A full "Analyze cleanup" run (every direct dependency) is in progress — the only genuinely-observable progress signal this produces is files scanned so far. */
  | { status: 'cleanup-analyzing'; scanned: number; total: number }
  /**
   * Likely-unused findings from a completed "Analyze cleanup" run — the
   * webview merges these with the deprecated/duplicate-version findings it
   * already has (`DashboardData.hygieneFindings`) and re-derives the
   * summary itself via the same `summarizeHygieneFindings` the host uses,
   * rather than trusting two independently-computed counts to agree.
   */
  | { status: 'cleanup-result'; findings: DependencyFinding[] }
  /** The cleanup run failed or was cancelled before producing a result. */
  | { status: 'cleanup-error'; error: ProtocolError };

/**
 * `package` and `target` are the smallest request that lets the host verify
 * the click against its own last-known state — see
 * src/core/upgrade/validate.ts. Neither value is trusted directly; both are
 * used only as lookup keys against the controller's most recent result.
 */
/**
 * `change-project` carries no payload at all — the webview can only ever ask
 * the host to open its picker, never name or choose a project itself. The
 * host owns project discovery and the candidate list end to end; nothing
 * here could be a raw filesystem path even by accident.
 */
/**
 * `open-advisory` never carries a URL — only the identifier of an advisory
 * already present in the host's own last scan. See
 * src/core/advisories/resolve.ts and DashboardController.resolveAdvisoryUrl
 * for why: the host resolves the actual URL itself from trusted data, so
 * there is nothing here for a compromised or buggy webview to redirect
 * `vscode.env.openExternal` toward.
 */
/**
 * `analysisId` is the only thing any of these four carry — the host looks it
 * up against its own in-memory analysis store (UpgradeAssistantCoordinator)
 * and refuses anything that doesn't match a real, still-fresh analysis it
 * created. The webview never sends plan contents, a target version, or
 * anything else that could be forged into execution authority — see
 * upgradeAssistantCoordinator.ts's handleConfirmUpgrade/handleUseSmartPlan.
 */
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'change-project' }
  | { type: 'upgrade'; package: string; target: string }
  | { type: 'open-advisory'; package: string; advisoryId: string | number; path: string[] }
  | { type: 'confirm-upgrade'; analysisId: string }
  /**
   * `analysisId: null` cancels a still-loading analysis (no id has been
   * issued yet) — the host drops its result instead of storing/posting it
   * once preflight finishes, rather than leaving the lock held until the
   * TTL backstop. A non-null id cancels a specific, already-delivered
   * analysis the same way confirm-upgrade/use-smart-plan target one.
   */
  | { type: 'cancel-upgrade'; analysisId: string | null }
  | { type: 'use-smart-plan'; analysisId: string }
  | { type: 'configure-verification' }
  /**
   * Only ever a package name — see resolveRemediationRequest
   * (src/core/advisories/remediationRequest.ts). The host re-derives the
   * row, the transitive advisory, and everything the resolver needs from its
   * own last-trusted scan; there is nothing here a compromised or buggy
   * webview could forge into a different analysis than the one its own row
   * actually shows.
   */
  | { type: 'analyze-remediation'; package: string }
  /** On-demand, single-package usage scan — see src/core/usage/ and src/host/usage/usageAnalyzer.ts. Only ever a package name; the host re-derives everything else (which project, which files) from its own trusted state. */
  | { type: 'where-used'; package: string }
  /** On-demand usage scan across every direct dependency at once — see usageCoordinator.ts's handleAnalyzeCleanup. No payload: there is nothing for the webview to choose here either. */
  | { type: 'analyze-cleanup' }
  /** Cancels whichever usage analysis (a `where-used` or an `analyze-cleanup` run) is currently in progress for this panel. */
  | { type: 'cancel-usage-analysis' }
  /**
   * The one place a usage-analysis reference is ever opened. `usageId` and
   * `referenceIndex` are opaque, host-issued values — never a filesystem
   * path or line number the webview constructed itself. See
   * src/host/usage/usageReferenceStore.ts for the trust boundary.
   */
  | { type: 'open-usage-reference'; usageId: string; referenceIndex: number };

const DATA_STATUSES: ReadonlySet<string> = new Set(['empty', 'ready', 'stale', 'partial-error']);

function isSelectedProjectInfo(value: unknown): value is SelectedProjectInfo {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['label', 'manifestPath']) &&
    typeof value['label'] === 'string' &&
    typeof value['manifestPath'] === 'string'
  );
}

function isDashboardData(value: unknown): value is DashboardData {
  if (!isRecord(value)) return false;
  const rows = value['rows'];
  const hygieneFindings = value['hygieneFindings'];
  return (
    Array.isArray(rows) &&
    rows.every(isPackageRow) &&
    typeof value['generatedAt'] === 'string' &&
    isSelectedProjectInfo(value['project']) &&
    typeof value['canChangeProject'] === 'boolean' &&
    isAbsentOr(value['advisoriesError'], isProtocolError) &&
    isAbsentOr(value['auditUnavailable'], (v) => typeof v === 'boolean') &&
    Array.isArray(hygieneFindings) &&
    hygieneFindings.every(isDependencyFinding)
  );
}

/**
 * Envelopes are closed shapes: an unrecognized top-level key means the message
 * did not come from the other half of this protocol, so it is rejected outright
 * rather than having its known fields trusted. Nested payload objects are
 * checked field-by-field without an extra-key sweep, matching how bulk.ts
 * parses registry JSON.
 */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  if (!isRecord(value)) return false;

  const type = value['type'];
  if (type === 'ready' || type === 'refresh' || type === 'change-project') {
    return hasOnlyKeys(value, ['type']);
  }
  if (type === 'upgrade') {
    return (
      hasOnlyKeys(value, ['type', 'package', 'target']) &&
      isNonEmptyString(value['package']) &&
      isNonEmptyString(value['target'])
    );
  }
  if (type === 'open-advisory') {
    const advisoryId = value['advisoryId'];
    const path = value['path'];
    return (
      hasOnlyKeys(value, ['type', 'package', 'advisoryId', 'path']) &&
      isNonEmptyString(value['package']) &&
      (typeof advisoryId === 'number' || isNonEmptyString(advisoryId)) &&
      Array.isArray(path) &&
      path.length > 0 &&
      path.every((segment) => typeof segment === 'string')
    );
  }
  if (type === 'confirm-upgrade' || type === 'use-smart-plan') {
    return hasOnlyKeys(value, ['type', 'analysisId']) && isNonEmptyString(value['analysisId']);
  }
  if (type === 'cancel-upgrade') {
    const analysisId = value['analysisId'];
    return hasOnlyKeys(value, ['type', 'analysisId']) && (analysisId === null || isNonEmptyString(analysisId));
  }
  if (type === 'configure-verification') {
    return hasOnlyKeys(value, ['type']);
  }
  if (type === 'analyze-remediation' || type === 'where-used') {
    return hasOnlyKeys(value, ['type', 'package']) && isNonEmptyString(value['package']);
  }
  if (type === 'analyze-cleanup' || type === 'cancel-usage-analysis') {
    return hasOnlyKeys(value, ['type']);
  }
  if (type === 'open-usage-reference') {
    const referenceIndex = value['referenceIndex'];
    return (
      hasOnlyKeys(value, ['type', 'usageId', 'referenceIndex']) &&
      isNonEmptyString(value['usageId']) &&
      typeof referenceIndex === 'number' &&
      Number.isInteger(referenceIndex) &&
      referenceIndex >= 0
    );
  }
  return false;
}

const COMPATIBILITY_FINDING_KINDS: ReadonlySet<string> = new Set<CompatibilityFindingKind>([
  'peer-compatible',
  'peer-incompatible',
  'peer-missing',
  'optional-peer-missing',
  'invalid-peer-range',
  'metadata-unavailable',
  'graph-metadata-incomplete',
  'major-version-change',
]);

const COMPATIBILITY_STATUSES: ReadonlySet<string> = new Set<CompatibilityStatus>([
  'compatible',
  'warning',
  'conflict',
  'unknown',
]);

const SECURITY_OUTCOME_STATUSES: ReadonlySet<string> = new Set<SecurityOutcomeStatus>([
  'resolved',
  'remains',
  'unknown',
  'not-applicable',
]);

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set<SupportedPackageManager>(['npm', 'pnpm']);
const CLASSIFICATIONS: ReadonlySet<string> = new Set<DependencyClassification>(['prod', 'dev', 'optional']);

function isPeerRequirement(value: unknown): value is PeerRequirement {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['name', 'range', 'optional']) &&
    typeof value['name'] === 'string' &&
    typeof value['range'] === 'string' &&
    typeof value['optional'] === 'boolean'
  );
}

function isDependencyRelation(value: unknown): value is DependencyRelation {
  if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'nodeIds', 'packageNames'])) return false;
  const kind = value['kind'];
  const nodeIds = value['nodeIds'];
  const packageNames = value['packageNames'];
  return (
    (kind === 'direct' || kind === 'transitive' || kind === 'peer') &&
    Array.isArray(nodeIds) &&
    nodeIds.every((id) => typeof id === 'string') &&
    Array.isArray(packageNames) &&
    packageNames.every((name) => typeof name === 'string')
  );
}

function isCompatibilityFinding(value: unknown): value is CompatibilityFinding {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'id',
      'kind',
      'status',
      'source',
      'subject',
      'requirement',
      'observedVersion',
      'relation',
      'explanation',
    ])
  ) {
    return false;
  }
  const subject = value['subject'];
  const observedVersion = value['observedVersion'];
  return (
    typeof value['id'] === 'string' &&
    typeof value['kind'] === 'string' &&
    COMPATIBILITY_FINDING_KINDS.has(value['kind']) &&
    typeof value['status'] === 'string' &&
    COMPATIBILITY_STATUSES.has(value['status']) &&
    value['source'] === 'static' &&
    isRecord(subject) &&
    hasOnlyKeys(subject, ['name', 'version', 'nodeId']) &&
    typeof subject['name'] === 'string' &&
    isStringOrNullField(subject['version']) &&
    isStringOrNullField(subject['nodeId']) &&
    isAbsentOr(value['requirement'], isPeerRequirement) &&
    (observedVersion === undefined || isStringOrNullField(observedVersion)) &&
    isDependencyRelation(value['relation']) &&
    typeof value['explanation'] === 'string'
  );
}

function isStringOrNullField(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isResolverVerification(value: unknown): value is ResolverVerification {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['status', 'packageManager', 'packageManagerVersion', 'code', 'explanation']) &&
    typeof value['status'] === 'string' &&
    COMPATIBILITY_STATUSES.has(value['status']) &&
    typeof value['packageManager'] === 'string' &&
    PACKAGE_MANAGERS.has(value['packageManager']) &&
    isStringOrNullField(value['packageManagerVersion']) &&
    typeof value['code'] === 'string' &&
    typeof value['explanation'] === 'string'
  );
}

function isCompatibilityCompleteness(value: unknown): value is CompatibilityCompleteness {
  return value === 'complete' || value === 'partial';
}

function isRemainingVulnerability(value: unknown): value is RemainingVulnerability {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['advisory', 'flaggedPackage', 'path', 'status', 'resolvedVersion', 'patchedVersion'])
  ) {
    return false;
  }
  const path = value['path'];
  const status = value['status'];
  return (
    isAdvisory(value['advisory']) &&
    typeof value['flaggedPackage'] === 'string' &&
    Array.isArray(path) &&
    path.every((segment) => typeof segment === 'string') &&
    (status === 'remains' || status === 'unknown') &&
    isStringOrNullField(value['resolvedVersion']) &&
    isPatchedVersionResult(value['patchedVersion'])
  );
}

function isSecurityOutcome(value: unknown): value is SecurityOutcome {
  if (!isRecord(value) || !hasOnlyKeys(value, ['status', 'resolvedAdvisories', 'remaining'])) return false;
  const status = value['status'];
  const resolvedAdvisories = value['resolvedAdvisories'];
  const remaining = value['remaining'];
  return (
    typeof status === 'string' &&
    SECURITY_OUTCOME_STATUSES.has(status) &&
    Array.isArray(resolvedAdvisories) &&
    resolvedAdvisories.every(isAttributedAdvisory) &&
    Array.isArray(remaining) &&
    remaining.every(isRemainingVulnerability)
  );
}

function isUpgradeAnalysisPresentation(value: unknown): value is UpgradeAnalysisPresentation {
  if (!isRecord(value)) return false;

  if (
    !hasOnlyKeys(value, [
      'analysisId',
      'package',
      'currentVersion',
      'targetVersion',
      'classification',
      'majorUpdate',
      'compatibility',
      'security',
      'smartPlan',
      'verification',
      'files',
    ])
  ) {
    return false;
  }

  const compatibility = value['compatibility'];
  if (!isRecord(compatibility)) return false;
  const findings = compatibility['findings'];
  const compatibilityOk =
    hasOnlyKeys(compatibility, ['status', 'completeness', 'findings', 'resolverVerification']) &&
    typeof compatibility['status'] === 'string' &&
    COMPATIBILITY_STATUSES.has(compatibility['status']) &&
    isCompatibilityCompleteness(compatibility['completeness']) &&
    Array.isArray(findings) &&
    findings.every(isCompatibilityFinding) &&
    isAbsentOr(compatibility['resolverVerification'], isResolverVerification);
  if (!compatibilityOk) return false;

  const security = value['security'];
  if (security !== null && !isSecurityOutcome(security)) return false;

  const smartPlan = value['smartPlan'];
  if (smartPlan !== null) {
    if (!isRecord(smartPlan) || !hasOnlyKeys(smartPlan, ['changes', 'reasonFindingIds'])) return false;
    const changes = smartPlan['changes'];
    const reasonFindingIds = smartPlan['reasonFindingIds'];
    const smartPlanOk =
      Array.isArray(changes) &&
      changes.every(
        (change) =>
          isRecord(change) &&
          hasOnlyKeys(change, ['packageName', 'currentVersion', 'targetVersion']) &&
          typeof change['packageName'] === 'string' &&
          typeof change['currentVersion'] === 'string' &&
          typeof change['targetVersion'] === 'string'
      ) &&
      Array.isArray(reasonFindingIds) &&
      reasonFindingIds.every((id) => typeof id === 'string');
    if (!smartPlanOk) return false;
  }

  const verification = value['verification'];
  if (!isRecord(verification)) return false;
  const verificationOk =
    verification['configured'] === false
      ? hasOnlyKeys(verification, ['configured'])
      : verification['configured'] === true &&
        hasOnlyKeys(verification, ['configured', 'scriptNames']) &&
        Array.isArray(verification['scriptNames']) &&
        verification['scriptNames'].every((name) => typeof name === 'string');
  if (!verificationOk) return false;

  const files = value['files'];
  if (
    !isRecord(files) ||
    !hasOnlyKeys(files, ['manifestPath', 'lockfilePath', 'rollbackAvailable']) ||
    typeof files['manifestPath'] !== 'string' ||
    typeof files['lockfilePath'] !== 'string' ||
    typeof files['rollbackAvailable'] !== 'boolean'
  ) {
    return false;
  }

  return (
    typeof value['analysisId'] === 'string' &&
    typeof value['package'] === 'string' &&
    typeof value['currentVersion'] === 'string' &&
    typeof value['targetVersion'] === 'string' &&
    typeof value['classification'] === 'string' &&
    CLASSIFICATIONS.has(value['classification']) &&
    typeof value['majorUpdate'] === 'boolean'
  );
}

const REMEDIATION_OUTCOME_STATUSES: ReadonlySet<string> = new Set<RemediationOutcomeStatus>([
  'resolved',
  'remains',
  'unknown',
]);

function isRemediationResult(value: unknown): value is RemediationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ['status', 'security'])) return false;
  const status = value['status'];
  return typeof status === 'string' && REMEDIATION_OUTCOME_STATUSES.has(status) && isSecurityOutcome(value['security']);
}

const REFERENCE_KINDS: ReadonlySet<string> = new Set(['import', 'require', 'dynamic-import', 'script', 'config']);

function isDependencyReference(value: unknown): value is DependencyReference {
  if (!isRecord(value)) return false;
  return (
    typeof value['filePath'] === 'string' &&
    typeof value['line'] === 'number' &&
    typeof value['column'] === 'number' &&
    typeof value['snippet'] === 'string' &&
    typeof value['kind'] === 'string' &&
    REFERENCE_KINDS.has(value['kind']) &&
    isAbsentOr(value['context'], (v) => typeof v === 'string')
  );
}

function isDependencyUsageResult(value: unknown): value is DependencyUsageResult {
  if (!isRecord(value)) return false;
  const references = value['references'];
  return (
    typeof value['packageName'] === 'string' &&
    Array.isArray(references) &&
    references.every(isDependencyReference) &&
    typeof value['truncated'] === 'boolean' &&
    typeof value['scannedFileCount'] === 'number' &&
    typeof value['scannedAt'] === 'string'
  );
}

function isUsageAnalysisResult(value: unknown): value is UsageAnalysisResult {
  return isRecord(value) && isNonEmptyString(value['usageId']) && isDependencyUsageResult(value['result']);
}

export function isHostToWebviewMessage(value: unknown): value is HostToWebviewMessage {
  if (!isRecord(value)) return false;

  const status = value['status'];
  if (typeof status !== 'string') return false;

  if (status === 'loading') return hasOnlyKeys(value, ['status']);
  if (status === 'fatal-error') {
    return hasOnlyKeys(value, ['status', 'error']) && isProtocolError(value['error']);
  }
  if (status === 'upgrade-error') {
    return (
      hasOnlyKeys(value, ['status', 'package', 'error']) &&
      isNonEmptyString(value['package']) &&
      isProtocolError(value['error'])
    );
  }
  if (status === 'upgrade-analyzing') {
    const phase = value['phase'];
    return (
      hasOnlyKeys(value, ['status', 'package', 'phase']) &&
      isNonEmptyString(value['package']) &&
      (phase === 'compatibility' || phase === 'smart-plan')
    );
  }
  if (status === 'upgrade-analysis') {
    return hasOnlyKeys(value, ['status', 'analysis']) && isUpgradeAnalysisPresentation(value['analysis']);
  }
  if (status === 'remediation-analyzing') {
    return hasOnlyKeys(value, ['status', 'package']) && isNonEmptyString(value['package']);
  }
  if (status === 'remediation-result') {
    return (
      hasOnlyKeys(value, ['status', 'package', 'result']) &&
      isNonEmptyString(value['package']) &&
      isRemediationResult(value['result'])
    );
  }
  if (status === 'remediation-error') {
    return (
      hasOnlyKeys(value, ['status', 'package', 'error']) &&
      isNonEmptyString(value['package']) &&
      isProtocolError(value['error'])
    );
  }
  if (status === 'usage-analyzing') {
    return hasOnlyKeys(value, ['status', 'package']) && isNonEmptyString(value['package']);
  }
  if (status === 'usage-result') {
    return (
      hasOnlyKeys(value, ['status', 'package', 'analysis']) &&
      isNonEmptyString(value['package']) &&
      isUsageAnalysisResult(value['analysis'])
    );
  }
  if (status === 'usage-error') {
    return (
      hasOnlyKeys(value, ['status', 'package', 'error']) &&
      isNonEmptyString(value['package']) &&
      isProtocolError(value['error'])
    );
  }
  if (status === 'cleanup-analyzing') {
    return (
      hasOnlyKeys(value, ['status', 'scanned', 'total']) &&
      typeof value['scanned'] === 'number' &&
      typeof value['total'] === 'number'
    );
  }
  if (status === 'cleanup-result') {
    const findings = value['findings'];
    return hasOnlyKeys(value, ['status', 'findings']) && Array.isArray(findings) && findings.every(isDependencyFinding);
  }
  if (status === 'cleanup-error') {
    return hasOnlyKeys(value, ['status', 'error']) && isProtocolError(value['error']);
  }
  if (DATA_STATUSES.has(status)) {
    return hasOnlyKeys(value, ['status', 'data']) && isDashboardData(value['data']);
  }
  return false;
}
