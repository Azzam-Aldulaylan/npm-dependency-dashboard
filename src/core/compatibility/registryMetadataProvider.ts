import type { ResolvedRegistry } from '../types.js';
import type { HttpClient } from '../registry/http.js';
import type { EtagStore, PackageVersionMetadata } from '../registry/versions.js';
import { fetchPackageVersionMetadata } from '../registry/versions.js';
import type { PackageMetadataProvider } from './types.js';

/** Select a scoped registry without allowing a package name to affect URL structure. */
export function registryForPackage(registry: ResolvedRegistry, packageName: string): string {
  if (!packageName.startsWith('@')) return registry.url;
  const slash = packageName.indexOf('/');
  if (slash <= 1) return registry.url;
  return registry.scoped[packageName.slice(0, slash)] ?? registry.url;
}

/**
 * Lazy adapter over the existing project-independent ETag store. Constructing
 * it performs no I/O; one exact-version request occurs only when preflight asks
 * for that proposed version.
 */
export class RegistryPackageMetadataProvider implements PackageMetadataProvider {
  /** One provider is scoped to one host-owned preflight. Smart-plan search
   * revisits the same exact package/version across proposal states, so retain
   * pending and successful promises for that logical action only. Failed
   * requests are removed so a later state may revalidate a transient error. */
  private readonly pending = new Map<string, Promise<PackageVersionMetadata>>();

  constructor(
    private readonly client: HttpClient,
    private readonly store: EtagStore,
    private readonly registry: ResolvedRegistry
  ) {}

  async getPackageVersionMetadata(
    packageName: string,
    version: string,
    signal?: AbortSignal
  ): Promise<PackageVersionMetadata> {
    const key = `${packageName}\0${version}`;
    const existing = this.pending.get(key);
    if (existing !== undefined) return await existing;
    const request = fetchPackageVersionMetadata(
      this.client,
      this.store,
      registryForPackage(this.registry, packageName),
      packageName,
      version,
      signal
    );
    this.pending.set(key, request);
    try {
      return await request;
    } catch (cause) {
      if (this.pending.get(key) === request) this.pending.delete(key);
      throw cause;
    }
  }
}
