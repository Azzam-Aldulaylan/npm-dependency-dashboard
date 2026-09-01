/** Shared, safe presentation of host reason codes. Never print raw failures,
 * registry responses, filesystem paths or unknown reason strings to the UI. */
export interface CompatibilityLimitation {
  reason: string;
  nextStep: string;
}

const REASONS: Record<string, CompatibilityLimitation> = {
  'runtime-node-version-unknown': {
    reason: 'The Node version used to run or deploy this project is unknown. VS Code’s own Node version is not project evidence.',
    nextStep: 'Compare node --version in your project terminal and deployment settings with the target package’s Node requirement. Refresh alone cannot establish the runtime.',
  },
  'runtime-node-version-invalid': {
    reason: 'The supplied runtime version is not an exact Node version.',
    nextStep: 'Verify the Node version used to run and deploy the project.',
  },
  'project-node-range-missing': {
    reason: 'package.json does not declare engines.node, so the project’s supported Node range could not be compared.',
    nextStep: 'Declare the Node range your project actually supports, then analyze again. This does not verify the active runtime.',
  },
  'project-node-range-invalid': {
    reason: 'package.json engines.node is not a valid version range.',
    nextStep: 'Correct engines.node and analyze again.',
  },
  'invalid-target-node-engine': {
    reason: 'The target package publishes an invalid Node requirement.',
    nextStep: 'Check the maintainer’s release notes; repeating the same analysis will not repair that metadata.',
  },
  'project-runtime-information-incomplete': {
    reason: 'The project’s declared Node range or actual runtime version could not be verified.',
    nextStep: 'Check engines.node and the Node version used locally and in deployment.',
  },
  'root-entry-point-unverified': {
    reason: 'A package-root import could not be verified against the target’s main entry and published files.',
    nextStep: 'Check that import with your project’s build or typecheck; custom bundler entry points are outside this check.',
  },
  'conditional-exports-unresolved': {
    reason: 'An imported entry point depends on export conditions that this static check cannot resolve.',
    nextStep: 'Run your build or typecheck in the intended browser/server environment. Repeating the scan alone will not resolve those conditions.',
  },
  'published-files-incomplete': {
    reason: 'The published file inventory is incomplete, so one or more import paths could not be verified.',
    nextStep: 'Check registry access and npm availability, then analyze again; also verify the imports with your build.',
  },
  'target-exports-unavailable': {
    reason: 'The target’s export map could not be fully read.',
    nextStep: 'Check the target package’s documented entry points and run your build or typecheck.',
  },
  'target-surface-incomplete': {
    reason: 'Some imports could not be verified from the available export map or published file inventory.',
    nextStep: 'Review package entry points and run your build or typecheck.',
  },
  'target-metadata-unavailable': {
    reason: 'Metadata for the exact target version could not be fetched.',
    nextStep: 'Check registry access and authentication, then analyze again.',
  },
  'target-metadata-identity-mismatch': {
    reason: 'The retrieved metadata does not match the package and exact version being reviewed.',
    nextStep: 'Check the selected target and registry configuration, then analyze again.',
  },
  'target-surface-identity-mismatch': {
    reason: 'The published entry-point evidence belongs to a different package or version.',
    nextStep: 'Analyze the selected target again to obtain matching evidence.',
  },
  'target-surface-unavailable': {
    reason: 'The target package’s export map and published file evidence are unavailable.',
    nextStep: 'Check registry access and npm availability, then analyze again.',
  },
  'target-package-inspector-unavailable': {
    reason: 'npm could not be located to inspect the target package’s published files.',
    nextStep: 'Make npm available to the extension host, then analyze again.',
  },
  'target-package-inventory-unavailable': {
    reason: 'The target package’s published file inventory could not be downloaded or read within the safety limits.',
    nextStep: 'Check registry access and npm availability, then retry. An oversized inventory may still need manual verification.',
  },
  'target-package-inventory-timeout': {
    reason: 'Downloading the target package’s published file inventory exceeded the time limit. Import compatibility is not verified.',
    nextStep: 'Check registry access and retry, or verify the imports with your project’s build/typecheck before upgrading.',
  },
  'project-source-scan-truncated': {
    reason: 'Source evidence is incomplete: the scan reached a file/reference limit, could not read a file, or was cancelled.',
    nextStep: 'Check source-file access and use your build/typecheck for coverage beyond the bounded scan. Refresh cannot bypass its limits.',
  },
  'project-source-file-limit': {
    reason: 'Source discovery reached the file limit (6,000 by default), so additional source files may not have been checked.',
    nextStep: 'Use your project’s build and typecheck to cover files outside this bounded scan.',
  },
  'project-import-reference-limit': {
    reason: 'The scan found more than 400 imports of this package; only the first 400 references were retained.',
    nextStep: 'Review the reported imports and use your build/typecheck to verify the remaining references.',
  },
  'project-framework-file-limit': {
    reason: 'The scan reached its 200-file limit for framework and configuration evidence.',
    nextStep: 'Review the remaining routes and configuration against the framework’s migration guide.',
  },
  'project-source-file-unreadable': {
    reason: 'At least one source or configuration file could not be read or exceeded the 2 MB per-file limit.',
    nextStep: 'Check source-file access. Verify oversized files with your build/typecheck; retrying does not bypass the size limit.',
  },
  'project-source-scan-cancelled': {
    reason: 'Source discovery or reading was cancelled before all evidence could be collected.',
    nextStep: 'Analyze again to complete the source scan.',
  },
  'tooling-metadata-incomplete': {
    reason: 'Version or peer-dependency metadata for related tooling is missing or unresolved.',
    nextStep: 'Check the lockfile and registry access, then analyze again.',
  },
  'package-command-metadata-unavailable': {
    reason: 'Current or target executable metadata is missing, so removed package commands could not be compared.',
    nextStep: 'Check registry access and analyze again; review package.json scripts against the release notes.',
  },
  'finding-limit-reached': {
    reason: 'The analysis reached its 400-finding display limit; additional findings may exist.',
    nextStep: 'Address the reported findings and analyze again.',
  },
  'deprecated-api-rules-unavailable': {
    reason: 'No deprecated-API rules cover this package and target version yet. This is a coverage limit, not a failed scan.',
    nextStep: 'Review the package’s migration guide. The current detector covers next/legacy/image imports when targeting stable Next.js 16.',
  },
  'cancelled': { reason: 'This check was cancelled before it finished.', nextStep: 'Analyze again when ready.' },
};

export function projectCompatibilityLimitations(reason: string | undefined, status: string): CompatibilityLimitation[] {
  if (status === 'cancelled') return [REASONS['cancelled']!];
  const codes = [...new Set((reason ?? '').split('|'))];
  return codes.map((code) => Object.hasOwn(REASONS, code) ? REASONS[code]! : {
    reason: 'The analyzer could not verify its evidence; no more specific supported reason was provided.',
    nextStep: 'Analyze again. If it persists, verify this check manually before upgrading.',
  });
}

export function projectCompatibilityAnalyzerLabel(id: string): string {
  const labels: Record<string, string> = {
    'runtime-compatibility': 'Node requirements',
    'import-compatibility': 'Import paths',
    'package-script-compatibility': 'Package scripts',
    'tooling-peer-alignment': 'Related tooling',
    'next-migration-rules': 'Next.js migration rules',
    'deprecated-api-compatibility': 'Deprecated APIs (known rules)',
    'project-source-scan': 'Project source scan',
  };
  return Object.hasOwn(labels, id) ? labels[id]! : 'Compatibility check';
}
