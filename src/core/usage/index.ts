export type { DependencyReference, DependencyReferenceKind, DependencyUsageResult } from './types.js';
export { importedPackageName, specifierMatchesPackage } from './packageNameMatch.js';
export { scanSourceForImports } from './importScan.js';
export type { RawImportMatch } from './importScan.js';
export { findPackageInScripts } from './packageScripts.js';
export type { ScriptMatch } from './packageScripts.js';
export { CONFIG_FILE_GLOBS, configReferencesPackage } from './configHeuristics.js';
export { isFrameworkConventionPackage } from './frameworkConventions.js';
export { buildUnusedFinding } from './unused.js';
