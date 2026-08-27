import semver from 'semver';

import { createProjectCompatibilityFinding } from '../../findings.js';
import type {
  NextProjectCompatibilityRule,
  NextRuleAnalysisInput,
  NextRuleProjectFile,
} from './types.js';

const NEXT_15_RANGE = '>=15.0.0 <16.0.0';
const NEXT_15_5_RANGE = '>=15.5.0 <16.0.0';

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

function matchesTarget(input: NextRuleAnalysisInput, range: string): boolean {
  return input.identity.packageName === 'next' && semver.satisfies(input.identity.targetVersion, range);
}

/** Masks comments and string/template contents without moving source offsets. */
function maskComments(source: string): string {
  let result = '';
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        result += character;
      } else {
        result += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        result += '  ';
        index += 1;
        blockComment = false;
      } else {
        result += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (quote !== undefined) {
      result += character === '\n' ? '\n' : ' ';
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      result += '  ';
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === '/' && next === '*') {
      result += '  ';
      index += 1;
      blockComment = true;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      result += ' ';
      continue;
    }
    result += character;
  }
  return result;
}

interface DirectObjectProperty {
  keyOffset: number;
  valueOffset: number;
}

/**
 * Finds a direct property of one object literal. Nested objects and function
 * bodies are deliberately excluded: a migration example inside `webpack()`
 * is not evidence that the exported Next configuration uses that option.
 */
function findDirectObjectProperty(
  source: string,
  objectStart: number,
  propertyName: string
): DirectObjectProperty | undefined {
  let index = objectStart;
  let objectDepth = 0;
  let lastDirectSignificant = '';
  while (index < source.length) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      const start = index;
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && index + 1 < source.length) {
          value += source[index] ?? '';
          value += source[index + 1] ?? '';
          index += 2;
          continue;
        }
        value += source[index] ?? '';
        index += 1;
      }
      index += 1;
      let after = index;
      while (/\s/.test(source[after] ?? '')) after += 1;
      if (
        quote !== '`' && objectDepth === 1 &&
        (lastDirectSignificant === '{' || lastDirectSignificant === ',') &&
        value === propertyName && source[after] === ':'
      ) {
        let valueOffset = after + 1;
        while (/\s/.test(source[valueOffset] ?? '')) valueOffset += 1;
        return { keyOffset: start, valueOffset };
      }
      if (objectDepth === 1) lastDirectSignificant = 'string';
      continue;
    }
    // Conservatively skip a single-line regex literal. Misclassifying an
    // unusual division expression here can only suppress this migration
    // hint; it cannot manufacture a confirmed finding.
    if (character === '/' && next !== '/' && next !== '*') {
      index += 1;
      let inClass = false;
      while (index < source.length && source[index] !== '\n') {
        if (source[index] === '\\') index += 2;
        else if (source[index] === '[') { inClass = true; index += 1; }
        else if (source[index] === ']') { inClass = false; index += 1; }
        else if (source[index] === '/' && !inClass) { index += 1; break; }
        else index += 1;
      }
      if (objectDepth === 1) lastDirectSignificant = 'regex';
      continue;
    }
    if (character === '{') {
      objectDepth += 1;
      if (objectDepth === 1) lastDirectSignificant = '{';
      index += 1;
      continue;
    }
    if (character === '}') {
      objectDepth -= 1;
      if (objectDepth <= 0) return undefined;
      if (objectDepth === 1) lastDirectSignificant = '}';
      index += 1;
      continue;
    }
    if (
      objectDepth === 1 &&
      (lastDirectSignificant === '{' || lastDirectSignificant === ',') &&
      source.startsWith(propertyName, index)
    ) {
      const before = source[index - 1];
      const afterName = source[index + propertyName.length];
      if (!/[\w$]/.test(before ?? '') && !/[\w$]/.test(afterName ?? '')) {
        let after = index + propertyName.length;
        while (/\s/.test(source[after] ?? '')) after += 1;
        if (source[after] === ':') {
          let valueOffset = after + 1;
          while (/\s/.test(source[valueOffset] ?? '')) valueOffset += 1;
          return { keyOffset: index, valueOffset };
        }
      }
    }
    if (objectDepth === 1) lastDirectSignificant = character;
    index += 1;
  }
  return undefined;
}

function matchingObjectEnd(maskedSource: string, objectStart: number): number | undefined {
  let depth = 0;
  for (let index = objectStart; index < maskedSource.length; index += 1) {
    if (maskedSource[index] === '{') depth += 1;
    if (maskedSource[index] === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

/**
 * Returns only object literals that are directly exported as Next config, or
 * assigned to the identifier that is directly exported. This avoids turning
 * documentation/example objects elsewhere in next.config into confirmed
 * schema evidence without attempting arbitrary JavaScript evaluation.
 */
function exportedConfigObjectRanges(source: string): Array<{ start: number; end: number }> {
  const masked = maskComments(source);
  const starts = new Set<number>();
  for (const pattern of [
    /\bexport\s+default\s*\{/g,
    /\bmodule\.exports\s*=\s*\{/g,
  ]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(masked)) !== null) {
      const start = masked.indexOf('{', match.index);
      if (start !== -1) starts.add(start);
    }
  }

  const exportedNames = new Set<string>();
  for (const pattern of [
    /\bexport\s+default\s+([A-Za-z_$][\w$]*)\b/g,
    /\bmodule\.exports\s*=\s*([A-Za-z_$][\w$]*)\b/g,
  ]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(masked)) !== null) {
      const name = match[1];
      if (name !== undefined) exportedNames.add(name);
    }
  }
  for (const name of exportedNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(`\\b(?:const|let|var)\\s+${escaped}(?:\\s*:[^=;]{1,240})?\\s*=\\s*\\{`, 'g');
    let match: RegExpExecArray | null;
    while ((match = declaration.exec(masked)) !== null) {
      const start = masked.indexOf('{', match.index);
      if (start !== -1) starts.add(start);
    }
  }

  return [...starts].sort((left, right) => left - right).flatMap((start) => {
    const end = matchingObjectEnd(masked, start);
    return end === undefined ? [] : [{ start, end }];
  });
}

function sourcePosition(source: string, offset: number): { line: number; column: number; snippet: string } {
  const before = source.slice(0, offset);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = source.indexOf('\n', offset);
  return {
    line,
    column: offset - lineStart + 1,
    snippet: source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim().slice(0, 240),
  };
}

function fileEvidence(file: NextRuleProjectFile, source: string, offset: number) {
  const position = sourcePosition(source, offset);
  return {
    kind: 'project-config' as const,
    filePath: normalizePath(file.filePath),
    line: position.line,
    column: position.column,
    snippet: position.snippet,
    ...(file.usageId === undefined ? {} : { usageId: file.usageId }),
    ...(file.referenceIndex === undefined ? {} : { referenceIndex: file.referenceIndex }),
  };
}

const nextConfigRenameRule: NextProjectCompatibilityRule = {
  id: 'next-15-server-external-packages-rename',
  packageName: 'next',
  targetRange: NEXT_15_RANGE,
  affectedSourceRange: '<15.0.0',
  category: 'config',
  confidence: 'confirmed',
  evaluate(input) {
    if (!matchesTarget(input, this.targetRange)) return [];
    const findings = [];
    for (const file of input.files) {
      const filePath = normalizePath(file.filePath);
      if (!/(?:^|\/)next\.config\.(?:js|mjs|ts)$/.test(filePath)) continue;
      const propertyOffset = exportedConfigObjectRanges(file.content).flatMap(({ start, end }) => {
        const experimental = findDirectObjectProperty(file.content, start, 'experimental');
        if (
          experimental === undefined ||
          experimental.valueOffset >= end ||
          file.content[experimental.valueOffset] !== '{'
        ) return [];
        const renamed = findDirectObjectProperty(
          file.content,
          experimental.valueOffset,
          'serverComponentsExternalPackages'
        );
        return renamed === undefined || renamed.keyOffset >= end ? [] : [renamed.keyOffset];
      })[0];
      if (propertyOffset === undefined) continue;
      findings.push(createProjectCompatibilityFinding(input.identity, {
        ruleId: this.id,
        category: this.category,
        confidence: this.confidence,
        title: 'Configuration migration required',
        explanation: '`serverComponentsExternalPackages` was renamed when it became stable in Next.js 15.',
        migrationHint: 'Move the value out of `experimental` and use the top-level `serverExternalPackages` option.',
        evidence: [fileEvidence(file, file.content, propertyOffset)],
        source: 'framework-rule',
        discriminator: [filePath, propertyOffset],
      }));
    }
    return findings;
  },
};

function shellTokens(segment: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of segment) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token.length > 0) {
        tokens.push(token);
        token = '';
      }
      continue;
    }
    token += character;
  }
  if (token.length > 0) tokens.push(token);
  return tokens;
}

function invokesNextLint(command: string): boolean {
  const segments = command.split(/&&|\|\||[;|]/u);
  return segments.some((segment) => {
    const tokens = shellTokens(segment.trim());
    let index = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index] ?? '')) index += 1;
    const executable = tokens[index];
    if (executable === 'next') return tokens[index + 1] === 'lint';
    if (executable === 'npx' || executable === 'bunx') {
      return tokens[index + 1] === 'next' && tokens[index + 2] === 'lint';
    }
    if (executable === 'pnpm' || executable === 'yarn') {
      const nextIndex = tokens[index + 1] === 'exec' ? index + 2 : index + 1;
      return tokens[nextIndex] === 'next' && tokens[nextIndex + 1] === 'lint';
    }
    return false;
  });
}

const nextLintDeprecationRule: NextProjectCompatibilityRule = {
  id: 'next-15-5-next-lint-deprecation',
  packageName: 'next',
  targetRange: NEXT_15_5_RANGE,
  category: 'script',
  confidence: 'likely',
  evaluate(input) {
    if (!matchesTarget(input, this.targetRange)) return [];
    return Object.entries(input.scripts).flatMap(([scriptName, command]) => {
      if (!invokesNextLint(command)) return [];
      return [createProjectCompatibilityFinding(input.identity, {
        ruleId: this.id,
        category: this.category,
        confidence: this.confidence,
        title: 'Script migration recommended',
        explanation: '`next lint` is deprecated in Next.js 15.5. It still runs in this target and is removed in Next.js 16.',
        migrationHint: 'Migrate the script to the ESLint CLI or Biome; the official `next-lint-to-eslint-cli` codemod can preserve supported flags.',
        evidence: [{
          kind: 'package-script',
          filePath: 'package.json',
          snippet: command.slice(0, 240),
          context: scriptName,
        }],
        source: 'framework-rule',
        discriminator: [scriptName],
      })];
    });
  },
};

function isAppRouterEntry(filePath: string): boolean {
  return /(?:^|\/)app\/(?:.*\/)?(?:page|layout|route|default)\.(?:js|jsx|ts|tsx)$/.test(normalizePath(filePath));
}

function hasSynchronousParamsUsage(content: string): RegExpExecArray | undefined {
  const masked = maskComments(content);
  const receivesParams = /export\s+(?:default\s+)?(?:async\s+)?function\b[^\n(]*\([^)]{0,360}\{\s*params(?:\s*[,}:])/m.test(masked);
  if (!receivesParams) return undefined;
  if (/\bawait\s+params\b|(?:\bReact\.)?\buse\s*\(\s*params\s*\)/.test(masked)) return undefined;
  return /\bparams\s*\.|\b(?:const|let|var)\s*\{[^{}]+\}\s*=\s*params\b/m.exec(masked) ?? undefined;
}

const asyncRouteParamsRule: NextProjectCompatibilityRule = {
  id: 'next-15-async-route-params',
  packageName: 'next',
  targetRange: NEXT_15_RANGE,
  affectedSourceRange: '<15.0.0',
  category: 'framework-migration',
  confidence: 'likely',
  evaluate(input) {
    if (!matchesTarget(input, this.targetRange)) return [];
    return input.files.flatMap((file) => {
      if (!isAppRouterEntry(file.filePath)) return [];
      const match = hasSynchronousParamsUsage(file.content);
      if (match?.index === undefined) return [];
      const filePath = normalizePath(file.filePath);
      const baseEvidence = fileEvidence(file, file.content, match.index);
      return [createProjectCompatibilityFinding(input.identity, {
        ruleId: this.id,
        category: this.category,
        confidence: this.confidence,
        title: 'Route parameter migration recommended',
        explanation: 'Next.js 15 makes App Router `params` asynchronous. Synchronous access is temporarily supported in version 15 but warns and is not forward-compatible.',
        migrationHint: 'Await `params` in an async entry, or unwrap it with React `use()` in a synchronous component. Use `useParams()` only for client-side route parameters where appropriate.',
        evidence: [{ ...baseEvidence, kind: 'source-reference' }],
        source: 'framework-rule',
        discriminator: [filePath, match.index],
      })];
    });
  },
};

const eslintConfigNextAlignmentRule: NextProjectCompatibilityRule = {
  id: 'next-eslint-config-major-alignment',
  packageName: 'next',
  targetRange: NEXT_15_RANGE,
  category: 'tooling',
  confidence: 'likely',
  evaluate(input) {
    if (!matchesTarget(input, this.targetRange)) return [];
    const declaration = input.declaredDependencies['eslint-config-next'];
    if (declaration === undefined) return [];
    const range = semver.validRange(declaration);
    if (range === null || semver.satisfies(input.identity.targetVersion, range)) return [];
    return [createProjectCompatibilityFinding(input.identity, {
      ruleId: this.id,
      category: this.category,
      confidence: this.confidence,
      title: 'Next.js lint tooling needs review',
      explanation: `The declared eslint-config-next range (${declaration}) does not admit the selected Next.js ${input.identity.targetVersion} version.`,
      migrationHint: 'Review and upgrade `eslint-config-next`; the official Next.js 15 upgrade guide updates it together with Next.js.',
      evidence: [{
        kind: 'manifest-dependency',
        filePath: 'package.json',
        snippet: `"eslint-config-next": "${declaration}"`,
      }],
      source: 'framework-rule',
      discriminator: [declaration],
    })];
  },
};

export const nextProjectCompatibilityRules: readonly NextProjectCompatibilityRule[] = [
  nextConfigRenameRule,
  nextLintDeprecationRule,
  asyncRouteParamsRule,
  eslintConfigNextAlignmentRule,
];

export function runNextProjectCompatibilityRules(input: NextRuleAnalysisInput) {
  return nextProjectCompatibilityRules.flatMap((rule) => rule.evaluate(input));
}
