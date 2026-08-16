/** Host-owned selection of package scripts explicitly enabled for verification. */

export interface VerificationScript {
  id: string;
  scriptName: string;
}

const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export function selectVerificationScripts(
  manifestText: string,
  configured: readonly unknown[]
): VerificationScript[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const scripts = (parsed as Record<string, unknown>)['scripts'];
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return [];

  const selected: VerificationScript[] = [];
  const seen = new Set<string>();
  for (const raw of configured) {
    if (typeof raw !== 'string' || !SAFE_SCRIPT_NAME.test(raw) || seen.has(raw)) continue;
    if (!Object.hasOwn(scripts, raw) || typeof (scripts as Record<string, unknown>)[raw] !== 'string') {
      continue;
    }
    seen.add(raw);
    selected.push({ id: `package-script:${raw}`, scriptName: raw });
  }
  return selected;
}

export function buildVerificationScriptArgs(
  packageManager: 'npm' | 'pnpm',
  scriptName: string
): string[] {
  if (!SAFE_SCRIPT_NAME.test(scriptName)) throw new Error('Unsafe verification script name.');
  return packageManager === 'npm' ? ['run-script', scriptName] : ['run', scriptName];
}
