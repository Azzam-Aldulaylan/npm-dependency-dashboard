import type { PackageRow } from '../../src/core/types.js';

/** Shared label vocabulary for a row's prod/dev/optional classification — used by both the Manage header identity badge and the Overview tab's Package overview block. */
export const CLASSIFICATION_LABEL: Record<'prod' | 'dev' | 'optional', string> = {
  prod: 'Production',
  dev: 'Development',
  optional: 'Optional',
};

export function classificationOf(row: PackageRow): 'prod' | 'dev' | 'optional' {
  if (row.optional) return 'optional';
  return row.dev ? 'dev' : 'prod';
}
