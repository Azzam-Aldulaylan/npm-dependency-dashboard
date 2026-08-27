import { createProjectCompatibilityFinding } from './findings.js';
import type {
  ProjectCompatibilityAnalyzerResult,
  ProjectCompatibilityFinding,
  ProjectCompatibilityIdentity,
} from './types.js';

export interface TargetCommandEvidence {
  executable: string;
  subcommand?: string;
  status: 'supported' | 'unsupported' | 'deprecated';
  explanation: string;
  migrationHint?: string;
}

interface ShellInvocation {
  executable: string;
  args: string[];
}

/**
 * Minimal non-executing shell lexer. It only recognizes top-level command
 * boundaries and quoted tokens; substitutions and nested shell programs are
 * intentionally not interpreted.
 */
function lexInvocations(script: string): ShellInvocation[] {
  const segments: string[][] = [[]];
  let token = '';
  let quote: "'" | '"' | null = null;
  let escaping = false;

  const finishToken = (): void => {
    if (token.length > 0) {
      segments.at(-1)?.push(token);
      token = '';
    }
  };
  const finishSegment = (): void => {
    finishToken();
    if ((segments.at(-1)?.length ?? 0) > 0) segments.push([]);
  };

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index] ?? '';
    if (escaping) {
      token += character;
      escaping = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === ';' || character === '|' || character === '&' || character === '\n') {
      finishSegment();
      if ((character === '|' || character === '&') && script[index + 1] === character) index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      finishToken();
      continue;
    }
    token += character;
  }
  finishToken();

  return segments.flatMap((raw): ShellInvocation[] => {
    if (raw.length === 0) return [];
    let index = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[index] ?? '')) index += 1;
    let executable = raw[index];
    if (executable === undefined) return [];

    if (executable === 'npx' || executable === 'bunx') {
      index += 1;
      while ((raw[index] ?? '').startsWith('-')) index += 1;
      executable = raw[index];
    } else if ((executable === 'npm' || executable === 'pnpm' || executable === 'yarn') && raw[index + 1] === 'exec') {
      index += 2;
      while ((raw[index] ?? '').startsWith('-')) index += 1;
      executable = raw[index];
    }
    return executable === undefined ? [] : [{ executable, args: raw.slice(index + 1) }];
  });
}

export function analyzePackageScripts(input: {
  identity: ProjectCompatibilityIdentity;
  scripts: Readonly<Record<string, string>>;
  targetCommands: readonly TargetCommandEvidence[];
}): ProjectCompatibilityAnalyzerResult {
  const findings: ProjectCompatibilityFinding[] = [];
  const sortedScripts = Object.entries(input.scripts).sort(([left], [right]) => left.localeCompare(right));
  for (const [scriptName, script] of sortedScripts) {
    const invocations = lexInvocations(script);
    for (const command of input.targetCommands) {
      if (command.status === 'supported') continue;
      const matched = invocations.some(
        (invocation) =>
          invocation.executable === command.executable &&
          (command.subcommand === undefined || invocation.args[0] === command.subcommand)
      );
      if (!matched) continue;
      const descriptor = command.subcommand === undefined
        ? command.executable
        : `${command.executable} ${command.subcommand}`;
      findings.push(
        createProjectCompatibilityFinding(input.identity, {
          ruleId: command.status === 'unsupported' ? 'unsupported-package-command' : 'deprecated-package-command',
          category: 'script',
          confidence: command.status === 'unsupported' ? 'confirmed' : 'likely',
          title: command.status === 'unsupported' ? 'Script migration required' : 'Script migration recommended',
          explanation: `${scriptName} invokes ${descriptor}. ${command.explanation}`,
          ...(command.migrationHint === undefined ? {} : { migrationHint: command.migrationHint }),
          evidence: [
            {
              kind: 'package-script',
              filePath: 'package.json',
              context: scriptName,
              snippet: script.slice(0, 240),
            },
          ],
          discriminator: [scriptName, descriptor],
        })
      );
    }
  }
  return { analyzerId: 'package-script-compatibility', status: 'complete', findings };
}
