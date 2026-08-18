import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOOP_PERFORMANCE_RECORDER,
  PerformanceSession,
} from '../out/core/performance/measurement.js';

test('disabled performance instrumentation does not read the clock or emit output', () => {
  let clockReads = 0;
  let outputs = 0;
  const session = new PerformanceSession('disabled', {
    enabled: false,
    now: () => {
      clockReads += 1;
      return 0;
    },
    output: () => {
      outputs += 1;
    },
  });

  session.start('work')({ rows: 10 });
  session.increment('requests');
  session.setMetadata('rows', 10);
  assert.equal(session.finish(), undefined);
  assert.equal(clockReads, 0);
  assert.equal(outputs, 0);
  assert.equal(NOOP_PERFORMANCE_RECORDER.enabled, false);
});

test('a performance session records structured stages, counters, and total duration', () => {
  const times = [0, 5, 17, 25];
  let emitted;
  const session = new PerformanceSession('scan', {
    enabled: true,
    now: () => times.shift() ?? 25,
    output: (report, formatted) => {
      emitted = { report, formatted };
    },
  });

  const end = session.start('version metadata resolution');
  end({ packages: 12 });
  session.increment('registry requests', 12);
  session.setMetadata('direct dependencies', 12);
  const report = session.finish();

  assert.equal(report.durationMs, 25);
  assert.deepEqual(report.measurements, [{
    operation: 'version metadata resolution',
    durationMs: 12,
    metadata: { packages: 12 },
  }]);
  assert.deepEqual(report.metadata, { 'registry requests': 12, 'direct dependencies': 12 });
  assert.match(emitted.formatted, /version metadata resolution/);
  assert.match(emitted.formatted, /Total/);
});
