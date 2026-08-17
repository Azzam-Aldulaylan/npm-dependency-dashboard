import { performance } from 'node:perf_hooks';

import { buildPackageRows } from '../../out/core/pipeline.js';
import { PerformanceSession } from '../../out/core/performance/measurement.js';
import { MemoryEtagStore } from '../../out/core/registry/versions.js';
import { UsageReferenceIndex } from '../../out/core/usage/referenceIndex.js';
import { paginate } from '../../out/host/pagination.js';
import { summaryFilterPredicate, summaryMetrics } from '../../out/host/summaryMetrics.js';
import { sortRows } from '../../out/host/tableSort.js';

const REGISTRY = 'https://registry.benchmark.invalid';
const BULK = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const SIZES = [
  { name: 'Small', direct: 15, transitivePerDirect: 2, vulnerableEvery: 5 },
  { name: 'Medium', direct: 50, transitivePerDirect: 4, vulnerableEvery: 5 },
  { name: 'Large', direct: 125, transitivePerDirect: 8, vulnerableEvery: 5 },
];

function fixture({ direct, transitivePerDirect, vulnerableEvery }) {
  const dependencies = {};
  const packages = { '': { name: 'benchmark-project', version: '1.0.0', dependencies } };
  const vulnerable = new Set();

  for (let index = 0; index < direct; index += 1) {
    const name = `fixture-pkg-${String(index).padStart(3, '0')}`;
    dependencies[name] = '^1.0.0';
    if (index % vulnerableEvery === 0) vulnerable.add(name);
    const childDependencies = {};
    for (let child = 0; child < transitivePerDirect; child += 1) {
      const childName = `fixture-child-${String(index).padStart(3, '0')}-${String(child).padStart(2, '0')}`;
      childDependencies[childName] = '^1.0.0';
      packages[`node_modules/${name}/node_modules/${childName}`] = { version: '1.0.0' };
    }
    packages[`node_modules/${name}`] = {
      version: '1.0.0',
      ...(transitivePerDirect === 0 ? {} : { dependencies: childDependencies }),
    };
  }

  return {
    manifestText: JSON.stringify({
      name: 'benchmark-project',
      version: '1.0.0',
      dependencies,
    }),
    lockfileText: JSON.stringify({
      name: 'benchmark-project',
      version: '1.0.0',
      lockfileVersion: 3,
      packages,
    }),
    vulnerable,
    graphNodes: Object.keys(packages).length - 1,
  };
}

function response(body, etag) {
  const text = JSON.stringify(body);
  return {
    status: 200,
    headers: etag === undefined ? {} : { etag },
    body: text,
    wireBytes: Buffer.byteLength(text),
  };
}

function delay(milliseconds) {
  return milliseconds === 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fakeAdapters(fixtureData, latency) {
  const calls = [];
  const events = [];
  let inFlightPackuments = 0;
  let peakPackuments = 0;

  const client = {
    calls,
    events,
    get peakPackuments() {
      return peakPackuments;
    },
    async get(url) {
      const kind = url.endsWith('/latest') ? 'latest' : 'packument';
      calls.push({ method: 'GET', kind, url });
      events.push({ event: 'start', kind, at: performance.now() });
      if (kind === 'packument') {
        inFlightPackuments += 1;
        peakPackuments = Math.max(peakPackuments, inFlightPackuments);
      }
      await delay(kind === 'latest' ? latency.latest : latency.packument);
      if (kind === 'packument') inFlightPackuments -= 1;
      events.push({ event: 'end', kind, at: performance.now() });
      return kind === 'latest'
        ? response({ version: '1.2.0', license: 'MIT' }, '"latest"')
        : response({
            'dist-tags': { latest: '1.2.0' },
            versions: { '1.0.0': {}, '1.0.1': {}, '1.1.0': {}, '1.2.0': {} },
          }, '"packument"');
    },
    async post(url) {
      calls.push({ method: 'POST', kind: 'advisories', url });
      events.push({ event: 'start', kind: 'advisories', at: performance.now() });
      await delay(latency.advisories);
      const advisories = {};
      for (const name of fixtureData.vulnerable) {
        advisories[name] = [{
          id: `benchmark-${name}`,
          severity: 'high',
          title: 'Deterministic benchmark advisory',
          url: 'https://example.invalid/advisory',
          vulnerable_versions: '<1.0.1',
        }];
      }
      events.push({ event: 'end', kind: 'advisories', at: performance.now() });
      if (url !== BULK) throw new Error(`unexpected POST ${url}`);
      return response(advisories);
    },
  };

  const auditRunner = {
    calls: 0,
    async run() {
      this.calls += 1;
      events.push({ event: 'start', kind: 'audit', at: performance.now() });
      await delay(latency.audit);
      events.push({ event: 'end', kind: 'audit', at: performance.now() });
      return {
        stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }),
        exitCode: 0,
      };
    },
  };

  return { client, auditRunner };
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function format(value) {
  return `${value.toFixed(1)} ms`;
}

function measure(iterations, operation) {
  const values = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    operation();
    values.push(performance.now() - started);
  }
  return median(values);
}

function dashboardRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `fixture-pkg-${String(index).padStart(3, '0')}`,
    current: '1.0.0',
    wanted: index % 3 === 0 ? '1.1.0' : '1.0.0',
    latest: index % 5 === 0 ? '2.0.0' : '1.1.0',
    dev: index % 4 === 0,
    range: '^1.0.0',
    advisories: [],
    worstSeverity: index % 10 === 0 ? 'high' : null,
    upgradeTo: index % 3 === 0 ? '1.1.0' : null,
    upgradeReason: index % 3 === 0 ? 'wanted' : null,
  }));
}

function runWebviewCpuCase() {
  const rows = dashboardRows(150);
  let pageRows = [];
  const durationMs = measure(1_000, () => {
    const matches = summaryFilterPredicate('updates');
    const filtered = rows.filter((row) => matches(row) && row.name.includes('fixture'));
    const sorted = sortRows(filtered, { column: 'available', direction: 'desc' }, 'updates');
    pageRows = paginate(sorted, 1, 25).pageRows;
    summaryMetrics(rows);
  });
  if (pageRows.length > 25) throw new Error('pagination rendered more than the requested page');
  return { durationMs, renderedRows: pageRows.length };
}

function runUsageCpuCase() {
  const packageNames = Array.from({ length: 125 }, (_, index) => `fixture-pkg-${String(index).padStart(3, '0')}`);
  const sources = Array.from({ length: 1_000 }, (_, index) => {
    const first = packageNames[index % packageNames.length];
    const second = packageNames[(index * 7) % packageNames.length];
    return `import value from '${first}';\nconst other = require('${second}');\nexport { value, other };`;
  });
  let scanCalls = 0;
  const durationMs = measure(15, () => {
    const index = new UsageReferenceIndex(packageNames, (source) => {
      scanCalls += 1;
      const matches = [];
      for (const match of source.matchAll(/(?:from |require\()['\"]([^'\"]+)['\"]/g)) {
        matches.push({ packageName: match[1], line: 0, column: 0, snippet: match[0], kind: 'import' });
      }
      return matches;
    });
    sources.forEach((source, sourceIndex) => index.addSourceFile(`src/file-${sourceIndex}.ts`, source));
  });
  const expectedCalls = sources.length * 15;
  if (scanCalls !== expectedCalls) throw new Error(`usage scanner called ${scanCalls} times; expected ${expectedCalls}`);
  return { durationMs, files: sources.length, dependencies: packageNames.length };
}

async function runCase(size, latency, iterations) {
  const fixtureData = fixture(size);
  const totals = [];
  const reports = [];
  let final;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const adapters = fakeAdapters(fixtureData, latency);
    const measurement = new PerformanceSession('benchmark scan', { enabled: true, output: () => undefined });
    const started = performance.now();
    const result = await buildPackageRows({
      root: '/benchmark/project',
      manifestText: fixtureData.manifestText,
      lockfileText: fixtureData.lockfileText,
      registry: REGISTRY,
      httpClient: adapters.client,
      etagStore: new MemoryEtagStore(),
      auditRunner: adapters.auditRunner,
      performance: measurement,
    });
    const total = performance.now() - started;
    totals.push(total);
    reports.push(measurement.finish());
    final = { adapters, result };
  }

  const packumentCalls = final.adapters.client.calls.filter((call) => call.kind === 'packument').length;
  const latestCalls = final.adapters.client.calls.filter((call) => call.kind === 'latest').length;
  const operationDurations = new Map();
  for (const report of reports) {
    for (const entry of report.measurements) {
      const values = operationDurations.get(entry.operation) ?? [];
      values.push(entry.durationMs);
      operationDurations.set(entry.operation, values);
    }
  }
  return {
    name: size.name,
    direct: size.direct,
    graphNodes: fixtureData.graphNodes,
    vulnerable: fixtureData.vulnerable.size,
    totalMs: median(totals),
    latestCalls,
    packumentCalls,
    peakPackuments: final.adapters.client.peakPackuments,
    rows: final.result.rows.length,
    stages: Object.fromEntries([...operationDurations].map(([name, values]) => [name, median(values)])),
  };
}

async function main() {
  console.log('Dependency Dashboard performance benchmark');
  console.log('CPU/local processing (zero-latency fixture adapters; median of 7)');
  for (const size of SIZES) {
    const result = await runCase(size, { latest: 0, packument: 0, advisories: 0, audit: 0 }, 7);
    console.log(
      `${result.name.padEnd(7)} ${String(result.direct).padStart(3)} direct / ${String(result.graphNodes).padStart(4)} nodes  ` +
      `${format(result.totalMs).padStart(10)}  requests latest=${result.latestCalls} packument=${result.packumentCalls}`
    );
  }

  console.log('');
  console.log('Controlled mocked latency (8ms latest, 20ms packument, 30ms advisory, 50ms audit; median of 3)');
  console.log('These are deterministic adapter timings, not npm-registry timings.');
  for (const size of SIZES) {
    const result = await runCase(size, { latest: 8, packument: 20, advisories: 30, audit: 50 }, 3);
    console.log(
      `${result.name.padEnd(7)} ${String(result.direct).padStart(3)} direct / ${String(result.vulnerable).padStart(2)} flagged  ` +
      `${format(result.totalMs).padStart(10)}  requests latest=${result.latestCalls} packument=${result.packumentCalls} ` +
      `peak-packuments=${result.peakPackuments}  ` +
      `versions=${format(result.stages['version metadata resolution'] ?? 0)} ` +
      `advisories=${format(result.stages['bulk advisory request'] ?? 0)} ` +
      `patched=${format(result.stages['patched-version metadata'] ?? 0)} ` +
      `audit=${format(result.stages['npm audit'] ?? 0)}`
    );
  }

  const webview = runWebviewCpuCase();
  console.log('');
  console.log('Webview/local CPU (150 rows; median of 1,000)');
  console.log(`Filter -> search -> sort -> paginate -> metrics  ${format(webview.durationMs)}  rendered=${webview.renderedRows}`);

  const usage = runUsageCpuCase();
  console.log('');
  console.log('Usage index/local CPU (125 dependencies, 1,000 source files; median of 15)');
  console.log(`One parse per source file, shared by every dependency  ${format(usage.durationMs)}`);
}

await main();
