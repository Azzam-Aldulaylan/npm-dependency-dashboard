/**
 * `npm audit --json` parsing and fixAvailable attribution.
 *
 * The two fixtures below are verbatim shapes captured from real `npm audit
 * --json` runs against scratch projects, so they are regression fixtures, not
 * invented ones:
 *
 *   MINIMATCH_REPORT   a vulnerable DIRECT dependency — the entry names itself
 *   EXPRESS_REPORT     a vulnerable TRANSITIVE dependency (body-parser) whose
 *                      fixAvailable names the DIRECT dependency (express)
 *
 * The second is the whole reason attribution validates `fixAvailable.name`
 * rather than trusting the top-level key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseNpmAuditOutput,
  mapFixAvailableToDirectDependencies,
  runNpmAudit,
  resolveAuditSpawnConfig,
  AuditUnavailableError,
} from '../out/core/audit/npmAudit.js';

// --------------------------------------------------------- Windows .cmd spawn

test('on Windows, npm.cmd is spawned through an explicit shell (CVE-2024-27980)', () => {
  // Patched Node throws EINVAL spawning a .bat/.cmd on win32 without
  // shell: true — this is a hard runtime error, not just a hardening choice.
  const config = resolveAuditSpawnConfig('win32');
  assert.deepEqual(config, { command: 'npm.cmd', shell: true });
});

test('on POSIX platforms, npm is spawned directly with no shell', () => {
  for (const platform of ['linux', 'darwin']) {
    const config = resolveAuditSpawnConfig(platform);
    assert.deepEqual(config, { command: 'npm', shell: false }, `platform ${platform}`);
  }
});

const MINIMATCH_REPORT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    minimatch: {
      name: 'minimatch',
      severity: 'high',
      isDirect: true,
      via: [
        {
          source: 1096549,
          name: 'minimatch',
          title: 'minimatch ReDoS vulnerability',
          url: 'https://github.com/advisories/GHSA-f8q6-p94x-37v3',
          severity: 'high',
          range: '<3.0.5',
        },
      ],
      effects: [],
      range: '<=3.1.3',
      nodes: ['node_modules/minimatch'],
      fixAvailable: { name: 'minimatch', version: '3.1.5', isSemVerMajor: false },
    },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
});

const EXPRESS_REPORT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    'body-parser': {
      name: 'body-parser',
      severity: 'high',
      isDirect: false,
      via: [
        {
          source: 1099520,
          name: 'body-parser',
          title: 'body-parser vulnerable to denial of service',
          url: 'https://github.com/advisories/GHSA-qwcr-r2fm-qrc7',
          severity: 'high',
          range: '<1.20.3',
        },
        'qs',
      ],
      effects: ['express'],
      range: '<=1.20.5',
      nodes: ['node_modules/body-parser'],
      fixAvailable: { name: 'express', version: '4.22.2', isSemVerMajor: false },
    },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
});

// ------------------------------------------------------------- parsing

test('a direct-dependency report parses into its entry', () => {
  const parsed = parseNpmAuditOutput(MINIMATCH_REPORT);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], {
    name: 'minimatch',
    isDirect: true,
    fixAvailable: { name: 'minimatch', version: '3.1.5', isSemVerMajor: false },
  });
});

test('a transitive report keeps the entry name and the fix name separate', () => {
  const parsed = parseNpmAuditOutput(EXPRESS_REPORT);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'body-parser', 'the entry is keyed by the vulnerable package');
  assert.equal(parsed[0].isDirect, false);
  assert.equal(parsed[0].fixAvailable.name, 'express', 'the fix names the direct dependency');
});

test('non-JSON stdout is AuditUnavailableError, not a crash', () => {
  assert.throws(() => parseNpmAuditOutput('npm ERR! code ENOLOCK'), AuditUnavailableError);
  assert.throws(() => parseNpmAuditOutput(''), AuditUnavailableError);
});

test('valid JSON without a vulnerabilities block is AuditUnavailableError', () => {
  assert.throws(() => parseNpmAuditOutput('{"auditReportVersion":2}'), AuditUnavailableError);
  assert.throws(() => parseNpmAuditOutput('[]'), AuditUnavailableError);
  assert.throws(() => parseNpmAuditOutput('"a string"'), AuditUnavailableError);
});

test('an empty vulnerabilities block is a clean project, not a failure', () => {
  assert.deepEqual(parseNpmAuditOutput('{"vulnerabilities":{}}'), []);
});

test('one malformed entry is dropped without discarding the rest', () => {
  const stdout = JSON.stringify({
    vulnerabilities: {
      good: { name: 'good', isDirect: true, fixAvailable: true },
      'missing-isDirect': { name: 'missing-isDirect', fixAvailable: true },
      'bad-name': { name: 42, isDirect: true, fixAvailable: true },
      'bad-fix-shape': { name: 'bad-fix-shape', isDirect: true, fixAvailable: { name: 'x' } },
      'fix-version-not-string': {
        name: 'fix-version-not-string',
        isDirect: true,
        fixAvailable: { name: 'x', version: 3, isSemVerMajor: false },
      },
      'not-an-object': 'nope',
    },
  });
  assert.deepEqual(parseNpmAuditOutput(stdout), [
    { name: 'good', isDirect: true, fixAvailable: true },
  ]);
});

test('a __proto__ key in the vulnerabilities block is skipped, not treated as an entry', () => {
  // Built from a raw JSON string, not an object literal: JSON.parse gives
  // "__proto__" as a genuine own enumerable property (via DefineOwnProperty),
  // which is exactly what Object.entries would otherwise iterate over and
  // exactly what the guard in parseNpmAuditOutput exists to skip.
  const stdout =
    '{"vulnerabilities":{"__proto__":{"name":"evil","isDirect":true,"fixAvailable":true},' +
    '"good":{"name":"good","isDirect":true,"fixAvailable":true}}}';

  const parsed = parseNpmAuditOutput(stdout);

  assert.deepEqual(parsed, [{ name: 'good', isDirect: true, fixAvailable: true }]);
  assert.equal(Object.prototype.evil, undefined, 'Object.prototype itself was never touched');
});

test('runNpmAudit never inspects the exit code', async () => {
  // Confirmed live: audit exits 1 with a complete, valid report whenever it
  // finds anything. Branching on the exit code would discard the enrichment on
  // exactly the projects that have something to enrich.
  const runner = {
    calls: [],
    async run(cwd) {
      this.calls.push(cwd);
      return { stdout: MINIMATCH_REPORT, exitCode: 1 };
    },
  };
  const parsed = await runNpmAudit(runner, '/tmp/project');
  assert.deepEqual(runner.calls, ['/tmp/project']);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'minimatch');
});

// --------------------------------------------------------- attribution

test('a direct dependency fixing itself is attributed to its own row', () => {
  const map = mapFixAvailableToDirectDependencies(
    parseNpmAuditOutput(MINIMATCH_REPORT),
    new Set(['minimatch', 'react'])
  );
  assert.equal(map.size, 1);
  assert.deepEqual(map.get('minimatch'), {
    name: 'minimatch',
    version: '3.1.5',
    isSemVerMajor: false,
  });
});

test("a transitive fix lands on the direct dependency named by fixAvailable, not the entry's own name", () => {
  const map = mapFixAvailableToDirectDependencies(
    parseNpmAuditOutput(EXPRESS_REPORT),
    new Set(['express'])
  );
  assert.equal(map.has('body-parser'), false, 'never keyed by the vulnerable transitive package');
  assert.deepEqual(map.get('express'), {
    name: 'express',
    version: '4.22.2',
    isSemVerMajor: false,
  });
});

test('a fixAvailable naming an unknown package is dropped entirely', () => {
  // The validation this whole mapping exists for: express is not a declared
  // direct dependency here, so there is no row it could correctly land on.
  // Attributing it anywhere (e.g. onto body-parser) would be a fabrication.
  const map = mapFixAvailableToDirectDependencies(
    parseNpmAuditOutput(EXPRESS_REPORT),
    new Set(['minimatch', 'react'])
  );
  assert.equal(map.size, 0);
});

test('two entries resolving to the same direct dependency keep the higher version', () => {
  const vulnerabilities = [
    { name: 'a', isDirect: false, fixAvailable: { name: 'express', version: '4.20.0', isSemVerMajor: false } },
    { name: 'b', isDirect: false, fixAvailable: { name: 'express', version: '4.22.2', isSemVerMajor: false } },
    { name: 'c', isDirect: false, fixAvailable: { name: 'express', version: '4.18.1', isSemVerMajor: false } },
  ];
  const map = mapFixAvailableToDirectDependencies(vulnerabilities, new Set(['express']));
  assert.equal(map.get('express').version, '4.22.2');

  // Order-independent: the highest wins whichever way the entries arrive.
  const reversed = mapFixAvailableToDirectDependencies([...vulnerabilities].reverse(), new Set(['express']));
  assert.equal(reversed.get('express').version, '4.22.2');
});

test('an object entry is never clobbered by a later boolean for the same name', () => {
  const map = mapFixAvailableToDirectDependencies(
    [
      { name: 'x', isDirect: false, fixAvailable: { name: 'express', version: '4.22.2', isSemVerMajor: false } },
      { name: 'express', isDirect: true, fixAvailable: false },
      { name: 'express', isDirect: true, fixAvailable: true },
    ],
    new Set(['express'])
  );
  assert.deepEqual(map.get('express'), {
    name: 'express',
    version: '4.22.2',
    isSemVerMajor: false,
  });
});

test('an object always wins over a boolean recorded first', () => {
  const map = mapFixAvailableToDirectDependencies(
    [
      { name: 'express', isDirect: true, fixAvailable: true },
      { name: 'x', isDirect: false, fixAvailable: { name: 'express', version: '4.22.2', isSemVerMajor: false } },
    ],
    new Set(['express'])
  );
  assert.equal(map.get('express').version, '4.22.2');
});

test('a boolean fixAvailable on a transitive entry is not attributed to anything', () => {
  // A boolean carries no name, so nothing identifies which direct dependency
  // it belongs to. Guessing a parent would misattribute the fix.
  const map = mapFixAvailableToDirectDependencies(
    [
      { name: 'body-parser', isDirect: false, fixAvailable: true },
      { name: 'qs', isDirect: false, fixAvailable: false },
    ],
    new Set(['express', 'body-parser'])
  );
  assert.equal(map.size, 0);
});

test('a boolean fixAvailable on a direct entry is attributed to its own row', () => {
  const map = mapFixAvailableToDirectDependencies(
    [
      { name: 'minimatch', isDirect: true, fixAvailable: true },
      { name: 'react', isDirect: true, fixAvailable: false },
      { name: 'unknown', isDirect: true, fixAvailable: true },
    ],
    new Set(['minimatch', 'react'])
  );
  assert.equal(map.get('minimatch'), true);
  assert.equal(map.get('react'), false);
  assert.equal(map.has('unknown'), false, 'a direct-flagged entry we do not know is still dropped');
});

test('an unparseable fix version never throws out of the mapping', () => {
  const map = mapFixAvailableToDirectDependencies(
    [
      { name: 'a', isDirect: false, fixAvailable: { name: 'express', version: 'not-a-version', isSemVerMajor: false } },
      { name: 'b', isDirect: false, fixAvailable: { name: 'express', version: '4.22.2', isSemVerMajor: false } },
    ],
    new Set(['express'])
  );
  assert.equal(map.get('express').version, '4.22.2');
});
