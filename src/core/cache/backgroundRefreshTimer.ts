/**
 * A single, disposable interval timer — no vscode dependency (setInterval/
 * clearInterval are plain Node globals), just enough abstraction to make
 * scheduling itself testable without a real clock (inject a fake
 * `TimerScheduler` that just records calls) and to guarantee the real
 * implementation never keeps the Node process alive on its own.
 */

export interface TimerHandle {
  unref?(): void;
}

export interface TimerScheduler {
  setInterval(callback: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

/**
 * `unref()` (Node-only; a no-op if absent) means this timer alone never
 * keeps the extension host process — or a test runner — alive; it only
 * fires while something else is already keeping the event loop open.
 */
export const realTimerScheduler: TimerScheduler = {
  setInterval(callback, ms) {
    const handle: TimerHandle = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as unknown as NodeJS.Timeout);
  },
};

/**
 * Exists only while `start()` has been called and `stop()`/`dispose()`
 * hasn't — the panel-lifetime rule ("no background timer when the panel is
 * closed") is enforced by the *caller* calling `stop()` from its own
 * disposal, not by anything in this class reaching back out to check panel
 * state.
 */
export class BackgroundRefreshTimer {
  private handle: TimerHandle | undefined;

  constructor(
    private readonly scheduler: TimerScheduler,
    private readonly intervalMs: number,
    private readonly onTick: () => void
  ) {}

  get isRunning(): boolean {
    return this.handle !== undefined;
  }

  start(): void {
    if (this.handle !== undefined) return; // already running — starting twice is a no-op, not two timers
    this.handle = this.scheduler.setInterval(this.onTick, this.intervalMs);
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.scheduler.clearInterval(this.handle);
    this.handle = undefined;
  }

  dispose(): void {
    this.stop();
  }
}
