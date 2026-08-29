import type { Advisory } from '../types.js';

const PUBLIC_IDENTIFIER_PATTERN = /\b(?:GHSA-[a-z0-9-]+|CVE-\d{4}-\d{4,})\b/gi;

/** Human-facing identifiers: public aliases first, then npm's clearly-labelled source id. */
export function vulnerabilityIdentifiers(advisory: Advisory): string[] {
  const identifiers: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (trimmed === '' || seen.has(key)) return;
    seen.add(key);
    identifiers.push(trimmed);
  };

  for (const identifier of advisory.identifiers ?? []) {
    if (identifier.type === 'CVE') add(identifier.value.toUpperCase());
  }
  for (const identifier of advisory.identifiers ?? []) {
    if (identifier.type === 'GHSA') add(identifier.value.toUpperCase());
  }
  for (const source of [advisory.url, advisory.title]) {
    for (const match of source.match(PUBLIC_IDENTIFIER_PATTERN) ?? []) add(match.toUpperCase());
  }
  const npmSourceId = String(advisory.id);
  if (PUBLIC_IDENTIFIER_PATTERN.test(npmSourceId)) {
    add(npmSourceId.toUpperCase());
  } else {
    add(`npm:${npmSourceId}`);
  }
  PUBLIC_IDENTIFIER_PATTERN.lastIndex = 0;
  return identifiers;
}
