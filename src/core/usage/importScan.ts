/**
 * Static import/require/dynamic-import detection in one file's source text.
 *
 * Deliberately not a naive substring search: a package name appearing inside
 * a comment or an unrelated string literal must never count as usage (see
 * the redesign brief's own "comments do not count" / "plain string literals
 * do not automatically count" requirements). This runs two passes instead:
 *
 *   1. `stripComments` walks the text once, blanking `//` and `/* *\/`
 *      comment content with spaces (preserving every line break, so line
 *      numbers stay correct) while passing string/template literal content
 *      through untouched — length-preserving throughout, so every offset in
 *      the stripped text is the identical offset in the original.
 *   2. A small set of targeted patterns then finds only the specifier
 *      immediately following `import`, `require(`, `import(`, or
 *      `export ... from` — never an arbitrary quoted string elsewhere in
 *      the file.
 *
 * This is intentionally not a full JS/TS parser — it is good enough for the
 * common, statically-visible forms the redesign brief asks for, not a
 * promise of perfect detection.
 */

import { importedPackageName } from './packageNameMatch.js';

export interface RawImportMatch {
  /** The bare package name the specifier resolved to (subpath already stripped) — never the raw specifier. */
  packageName: string;
  line: number;
  column: number;
  snippet: string;
  kind: 'import' | 'require' | 'dynamic-import';
}

const MAX_SNIPPET_LENGTH = 160;

function stripComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n && text[i] !== quote) {
        const current = text[i] ?? '';
        if (current === '\\' && i + 1 < n) {
          out += current + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += current;
        i += 1;
      }
      if (i < n) {
        out += text[i];
        i += 1;
      }
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}

interface KeywordPattern {
  kind: RawImportMatch['kind'];
  regex: RegExp;
}

const QUOTED = "(['\"`])((?:\\\\.|(?!\\1).)*)\\1";

const KEYWORD_PATTERNS: KeywordPattern[] = [
  { kind: 'dynamic-import', regex: new RegExp(`\\bimport\\s*\\(\\s*${QUOTED}`, 'g') },
  { kind: 'require', regex: new RegExp(`\\brequire\\s*\\(\\s*${QUOTED}`, 'g') },
  // `import ... from '<spec>'` and `export ... from '<spec>'` — anything
  // between the keyword and `from` that isn't a quote/semicolon (covers
  // named/default/namespace/type imports and multi-line brace lists).
  { kind: 'import', regex: new RegExp(`\\b(?:import|export)\\b(?!\\s*\\()[^'"\`;]*?\\bfrom\\s*${QUOTED}`, 'g') },
  // Side-effect import: `import '<spec>'` — no `from`, so distinct from the pattern above.
  { kind: 'import', regex: new RegExp(`\\bimport\\s*${QUOTED}`, 'g') },
];

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function locate(lineStarts: readonly number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((lineStarts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  const lineStart = lineStarts[low] ?? 0;
  return { line: low + 1, column: index - lineStart + 1 };
}

function lineTextAt(text: string, lineStarts: readonly number[], line: number): string {
  const start = lineStarts[line - 1] ?? 0;
  const rawEnd = text.indexOf('\n', start);
  const end = rawEnd === -1 ? text.length : rawEnd;
  const raw = text.slice(start, end).trim();
  return raw.length > MAX_SNIPPET_LENGTH ? `${raw.slice(0, MAX_SNIPPET_LENGTH)}…` : raw;
}

export function scanSourceForImports(text: string): RawImportMatch[] {
  const cleaned = stripComments(text);
  const lineStarts = buildLineStarts(text);
  const matches: RawImportMatch[] = [];
  // Avoid double-reporting the same specifier occurrence under more than one
  // pattern (the `import ... from` and side-effect-`import` patterns are
  // mutually exclusive by construction, but keyed dedupe is cheap insurance).
  const seenAtIndex = new Set<number>();

  for (const { kind, regex } of KEYWORD_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
      const specifier = match[2] ?? '';
      const specifierIndex = match.index + match[0].lastIndexOf(specifier);
      if (seenAtIndex.has(specifierIndex)) continue;
      seenAtIndex.add(specifierIndex);

      const packageName = importedPackageName(specifier);
      if (packageName === null) continue;

      const { line, column } = locate(lineStarts, specifierIndex);
      matches.push({ packageName, line, column, snippet: lineTextAt(text, lineStarts, line), kind });
    }
  }

  matches.sort((a, b) => a.line - b.line || a.column - b.column);
  return matches;
}
