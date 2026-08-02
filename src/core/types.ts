/**
 * Core domain types.
 *
 * Nothing in src/core may import 'vscode'. This is enforced at compile time by
 * src/core/tsconfig.json, whose "types" list omits vscode — not by convention.
 * That keeps the whole pipeline testable without an extension host.
 */

/** Why a package has no registry version to compare against. */
export type UnresolvableReason =
  | 'workspace-link' // npm workspaces: "link": true in the lockfile, or link:/workspace: specifier
  | 'file' // file: specifier
  | 'git' // git:/github: specifier
  | 'alias' // npm: alias
  | 'tarball' // direct http(s) tarball URL
  | 'no-lockfile'; // no lockfile present; only a range is known

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

export interface DependencyNode {
  name: string;
  /** Resolved version from the lockfile, or null when unresolvable. */
  version: string | null;
  /** The range as declared in package.json, e.g. "^18.2.0". */
  range: string;
  dev: boolean;
  /** True for entries listed in the manifest's own dependencies. */
  direct: boolean;
  /** Lockfile path key, e.g. "node_modules/react". */
  path: string;
  /** Names of this node's own dependencies, for graph traversal. */
  deps: string[];
  /** Set when the package can't be resolved against a registry. */
  unresolvable?: UnresolvableReason;
}

export interface DependencyGraph {
  /** Absolute path to the directory holding package.json. */
  root: string;
  /** Which lockfile shape was parsed. */
  lockfileVersion: 1 | 2 | 3 | null;
  nodes: Map<string, DependencyNode>;
}

export interface VersionInfo {
  name: string;
  /** Highest version satisfying the declared range. */
  wanted: string | null;
  /** Highest stable version. Prereleases only when installed is a prerelease. */
  latest: string | null;
  deprecated?: string;
  /** SPDX id from /<pkg>/latest. Free under the hybrid fetch — see spec. */
  license?: string;
}

export interface Advisory {
  id: number | string;
  severity: Severity;
  title: string;
  url: string;
  vulnerableVersions: string;
}

/** An advisory attributed to a direct dependency, with the path we derived. */
export interface AttributedAdvisory {
  advisory: Advisory;
  /** The package the advisory is actually against. */
  flaggedPackage: string;
  /** Chain from the direct dependency down to flaggedPackage. */
  path: string[];
}

/**
 * `npm audit --json`'s per-package fix status — optional enrichment, not
 * available from the bulk advisories endpoint. Three shapes, not one:
 * `true` (fixable in place, no version bump needed), `false` (no fix), or an
 * object naming the version a fix requires (possibly a major bump).
 */
export type FixAvailable = true | false | { name: string; version: string; isSemVerMajor: boolean };

export interface PackageRow {
  name: string;
  /**
   * The real, lockfile-resolved installed version, or null when there is
   * none — never a range/spec string. Callers (upgrade eligibility in
   * particular) rely on `null` meaning "no real installed version exists";
   * see `range` below for what the UI shows instead in that case.
   */
  current: string | null;
  wanted: string | null;
  latest: string | null;
  dev: boolean;
  /** The declared package.json spec/range, e.g. "^18.2.0" or "file:../x". Display-only fallback for Current when `current` is null — never a substitute for a real installed version. */
  range: string;
  deprecated?: string;
  unresolvable?: UnresolvableReason;
  advisories: AttributedAdvisory[];
  /** Highest severity across advisories, or null when clean. */
  worstSeverity: Severity | null;
  /** Target version for the upgrade action, or null when not offerable. */
  upgradeTo: string | null;
}

/** Registry origin, surfaced in the UI so a redirect is never silent. */
export interface ResolvedRegistry {
  url: string;
  source: 'project-npmrc' | 'user-npmrc' | 'default';
  /** Scoped overrides, e.g. "@myco" -> "https://registry.myco.com". */
  scoped: Record<string, string>;
}
