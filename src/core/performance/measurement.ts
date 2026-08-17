import { performance } from 'node:perf_hooks';

export type PerformanceMetadataValue = number | string | boolean;
export type PerformanceMetadata = Record<string, PerformanceMetadataValue>;

export interface PerformanceMeasurement {
  operation: string;
  durationMs: number;
  metadata?: PerformanceMetadata;
}

export interface PerformanceReport {
  operation: string;
  durationMs: number;
  measurements: PerformanceMeasurement[];
  metadata: PerformanceMetadata;
}

export interface PerformanceRecorder {
  readonly enabled: boolean;
  start(operation: string): (metadata?: PerformanceMetadata) => number;
  increment(name: string, amount?: number): void;
  setMetadata(name: string, value: PerformanceMetadataValue): void;
}

const NOOP_END = (): number => 0;

export const NOOP_PERFORMANCE_RECORDER: PerformanceRecorder = Object.freeze({
  enabled: false,
  start: () => NOOP_END,
  increment: () => undefined,
  setMetadata: () => undefined,
});

export interface PerformanceSessionOptions {
  enabled: boolean;
  output?: (report: PerformanceReport, formatted: string) => void;
  now?: () => number;
}

function formatReport(report: PerformanceReport): string {
  const labels = report.measurements.map((entry) => entry.operation);
  const width = Math.max(24, ...labels.map((label) => label.length + 2));
  const lines = [report.operation];
  for (const entry of report.measurements) {
    lines.push(`${entry.operation.padEnd(width)}${entry.durationMs.toFixed(1).padStart(9)} ms`);
  }
  lines.push('-'.repeat(width + 12));
  lines.push(`${'Total'.padEnd(width)}${report.durationMs.toFixed(1).padStart(9)} ms`);
  const counters = Object.entries(report.metadata);
  if (counters.length > 0) {
    lines.push(counters.map(([name, value]) => `${name}=${String(value)}`).join('  '));
  }
  return lines.join('\n');
}

/**
 * One local diagnostic operation. When disabled, `start`, counters, and
 * `finish` avoid reading a clock or allocating measurement objects.
 */
export class PerformanceSession implements PerformanceRecorder {
  readonly enabled: boolean;
  private readonly now: () => number;
  private readonly output: (report: PerformanceReport, formatted: string) => void;
  private readonly startedAt: number;
  private readonly measurements: PerformanceMeasurement[] = [];
  private readonly metadata: PerformanceMetadata = {};
  private finished: PerformanceReport | undefined;

  constructor(
    private readonly operation: string,
    options: PerformanceSessionOptions
  ) {
    this.enabled = options.enabled;
    this.now = options.now ?? (() => performance.now());
    this.output = options.output ?? ((_, formatted) => console.debug(formatted));
    this.startedAt = this.enabled ? this.now() : 0;
  }

  start(operation: string): (metadata?: PerformanceMetadata) => number {
    if (!this.enabled) return NOOP_END;
    const startedAt = this.now();
    return (metadata?: PerformanceMetadata): number => {
      const durationMs = this.now() - startedAt;
      const measurement: PerformanceMeasurement = { operation, durationMs };
      if (metadata !== undefined && Object.keys(metadata).length > 0) measurement.metadata = metadata;
      this.measurements.push(measurement);
      return durationMs;
    };
  }

  increment(name: string, amount = 1): void {
    if (!this.enabled) return;
    const current = this.metadata[name];
    this.metadata[name] = (typeof current === 'number' ? current : 0) + amount;
  }

  setMetadata(name: string, value: PerformanceMetadataValue): void {
    if (!this.enabled) return;
    this.metadata[name] = value;
  }

  finish(metadata?: PerformanceMetadata): PerformanceReport | undefined {
    if (!this.enabled) return undefined;
    if (this.finished !== undefined) return this.finished;
    if (metadata !== undefined) {
      for (const [name, value] of Object.entries(metadata)) this.metadata[name] = value;
    }
    const report: PerformanceReport = {
      operation: this.operation,
      durationMs: this.now() - this.startedAt,
      measurements: [...this.measurements],
      metadata: { ...this.metadata },
    };
    this.finished = report;
    this.output(report, formatReport(report));
    return report;
  }
}

export function createPerformanceSession(
  operation: string,
  enabled: boolean,
  output?: PerformanceSessionOptions['output']
): PerformanceSession {
  return new PerformanceSession(operation, output === undefined ? { enabled } : { enabled, output });
}
