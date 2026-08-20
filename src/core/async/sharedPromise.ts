/** One logical operation shared by multiple consumers in the same action.
 * The promise is retained after settlement so sequential callers do not redo
 * identical project/network/subprocess work. Create a new instance at every
 * freshness boundary; this deliberately provides no cross-action cache. */
export class SharedPromise<T> {
  private pending: Promise<T> | undefined;

  get(factory: () => Promise<T>): Promise<T> {
    this.pending ??= factory();
    return this.pending;
  }
}
