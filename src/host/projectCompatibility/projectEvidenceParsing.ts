/** Pure, host-independent parsing helpers for project compatibility evidence. */

export interface ProjectManifestCompatibilityEvidence {
  scripts: Record<string, string>;
  declaredDependencies: Record<string, string>;
  projectNodeRange: string | null;
}

export function projectCompatibilityScanIsTruncated(input: {
  discoveredSourceFiles: number;
  maxFiles: number;
  sourceCancelled: boolean;
  configCancelled: boolean;
  failedReadCount: number;
  evidenceLimitReached: boolean;
}): boolean {
  return input.discoveredSourceFiles >= input.maxFiles ||
    input.sourceCancelled ||
    input.configCancelled ||
    input.failedReadCount > 0 ||
    input.evidenceLimitReached;
}

function readStringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof value !== 'object' || value === null) return result;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (typeof raw === 'string') result[key] = raw;
  }
  return result;
}

export function parseProjectManifestCompatibilityEvidence(manifestText: string): ProjectManifestCompatibilityEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return { scripts: {}, declaredDependencies: {}, projectNodeRange: null };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { scripts: {}, declaredDependencies: {}, projectNodeRange: null };
  }
  const manifest = parsed as Record<string, unknown>;
  const declarations = {
    ...readStringMap(manifest['devDependencies']),
    ...readStringMap(manifest['optionalDependencies']),
    ...readStringMap(manifest['dependencies']),
  };
  const engines = readStringMap(manifest['engines']);
  return {
    scripts: readStringMap(manifest['scripts']),
    declaredDependencies: declarations,
    projectNodeRange: engines['node'] ?? null,
  };
}

/** Narrow source retention: import scanning sees every source file, rule packs retain only files they actually inspect. */
export function shouldRetainFrameworkRuleFile(packageName: string, filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  if (packageName !== 'next') return false;
  return /(?:^|\/)app\/(?:.*\/)?(?:page|layout|route|default)\.(?:js|jsx|ts|tsx)$/.test(normalized);
}
