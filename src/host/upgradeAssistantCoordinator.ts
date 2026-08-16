/**
 * Host-side coordinator for one dependency-upgrade lifecycle.
 *
 * DashboardPanel owns the webview, project selection, watchers, and reload
 * machinery. This class owns everything from validating an untrusted upgrade
 * message through preflight, confirmation, transaction execution, final-state
 * reload, and user-visible completion. The narrow callbacks below keep those
 * responsibilities separate without weakening the panel-wide mutation lock.
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { buildDependencyGraph } from '../core/lockfile/build.js';
import { directNodes } from '../core/lockfile/parse.js';
import { parseManifest } from '../core/manifest/parse.js';
import { analyzeCompatibility, CompatibilityCancelledError } from '../core/compatibility/preflight.js';
import { RegistryPackageMetadataProvider, registryForPackage } from '../core/compatibility/registryMetadataProvider.js';
import type { HttpClient } from '../core/registry/http.js';
import { fetchPackument } from '../core/registry/versions.js';
import type { EtagStore } from '../core/registry/versions.js';
import { planSmartUpgrade } from '../core/upgrade/smartPlan.js';
import { describeRejection } from '../core/upgrade/validate.js';
import type { DashboardController, MessageSink } from './dashboardController.js';
import { createNodeNpmResolverDeps, resolveNpmInvocation } from './npmResolver.js';
import { createNodeUpgradeTransactionFileAdapter } from './nodeUpgradeTransactionFiles.js';
import { resolveInstalledPnpmInvocation } from './pnpmResolver.js';
import type { DiscoveredProject, ResolvedProject } from './projectResolution.js';
import { loadProject } from './projectResolution.js';
import { IsolatedResolverVerifier, probePackageManagerVersion } from './resolverVerifier.js';
import { describeUpgradeTransactionOutcome } from './upgradeAssistantOutcome.js';
import { confirmUpgrade, UpgradeExecutionSession } from './upgradeRunner.js';
import { runUpgradeTransaction } from './upgradeTransaction.js';
import { selectVerificationScripts } from './verificationPolicy.js';
import type { ProtocolError } from './webviewProtocol.js';

export interface UpgradeMessage {
  package: string;
  target: string;
}

export interface UpgradeAssistantCoordinatorOptions {
  sink: MessageSink;
  httpClient: HttpClient;
  etagStore: EtagStore;
  ensureController(): Promise<DashboardController | undefined>;
  getSelectedProject(): DiscoveredProject | undefined;
  isDisposed(): boolean;
  reloadFinalState(): Promise<void>;
  flushDeferredChanges(): Promise<void>;
  /** Test seam; production always uses the host-owned project loader. */
  loadProject?: (candidate: DiscoveredProject) => Promise<ResolvedProject>;
}

function toProtocolError(cause: unknown): ProtocolError {
  if (cause instanceof Error) return { code: cause.name, message: cause.message };
  return { code: 'UNKNOWN', message: String(cause) };
}

export function compatibilitySummary(analysis: Awaited<ReturnType<typeof analyzeCompatibility>>): string[] {
  const important = analysis.findings.filter((finding) => finding.status !== 'compatible').slice(0, 4);
  return [
    `Result: ${analysis.status}${analysis.completeness === 'partial' ? ' (partial evidence)' : ''}.`,
    ...important.map((finding) => `• ${finding.explanation}`),
    ...(analysis.findings.length > important.length
      ? [`• ${analysis.findings.length - important.length} additional finding(s).`]
      : []),
    ...(analysis.resolverVerification === undefined
      ? []
      : [`Resolver: ${analysis.resolverVerification.explanation}`]),
  ];
}

export class UpgradeAssistantCoordinator {
  private readonly session = new UpgradeExecutionSession();
  private readonly projectLoader: (candidate: DiscoveredProject) => Promise<ResolvedProject>;

  constructor(private readonly options: UpgradeAssistantCoordinatorOptions) {
    this.projectLoader = options.loadProject ?? loadProject;
  }

  isBusy(): boolean {
    return this.session.isBusy();
  }

  /** Dispose immediately only when no mutation is in flight. */
  disposeWhenIdle(): void {
    if (!this.session.isBusy()) this.session.dispose();
  }

  /**
   * Complete host-owned upgrade flow. Every package/version still passes the
   * controller's last-scan validation before this class constructs argv.
   */
  async handleUpgrade(message: UpgradeMessage): Promise<void> {
    const controller = await this.options.ensureController();
    if (controller === undefined) return;

    const eligibility = controller.validateUpgradeRequest({
      package: message.package,
      target: message.target,
    });
    if (!eligibility.ok) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: message.package,
        error: describeRejection(eligibility.reason),
      });
      return;
    }

    // Reserve across preflight and every modal, not merely process execution:
    // forged requests cannot stack confirmations or race package managers.
    if (!this.session.reserve(eligibility.packageName)) {
      this.options.sink.postMessage({
        status: 'upgrade-error',
        package: eligibility.packageName,
        error: { code: 'UPGRADE_IN_PROGRESS', message: 'Another upgrade is already in progress for this project.' },
      });
      return;
    }

    try {
      const selected = this.options.getSelectedProject();
      if (selected === undefined) return;
      const source = controller.upgradeSource;
      const preflightProject = await this.projectLoader(selected);
      if (
        preflightProject.root !== controller.root ||
        preflightProject.manifestText !== source.manifestText ||
        preflightProject.lockfileText !== source.lockfileText ||
        preflightProject.lockfilePath !== source.lockfilePath ||
        preflightProject.registry !== source.registry ||
        preflightProject.packageManager !== source.packageManager ||
        preflightProject.importerId !== source.importerId
      ) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: eligibility.packageName,
          error: { code: 'STALE_SOURCE', message: 'Project dependency files changed. Refresh and try again.' },
        });
        return;
      }

      let proposal = {
        requested: {
          packageName: eligibility.packageName,
          currentVersion: eligibility.currentVersion,
          targetVersion: eligibility.target,
          classification: eligibility.classification,
        },
        changes: [
          {
            packageName: eligibility.packageName,
            currentVersion: eligibility.currentVersion,
            targetVersion: eligibility.target,
            classification: eligibility.classification,
          },
        ],
      };
      const manifest = parseManifest(preflightProject.manifestText);
      const graph = buildDependencyGraph({
        root: preflightProject.root,
        manifest,
        lockfileText: preflightProject.lockfileText,
        packageManager: preflightProject.packageManager,
        importerId: preflightProject.importerId,
      });
      const npmResolution = resolveNpmInvocation(createNodeNpmResolverDeps(controller.root));
      const packageManagerInvocation =
        !npmResolution.ok
          ? null
          : preflightProject.packageManager === 'npm'
            ? {
                executable: npmResolution.invocation.node,
                prefixArgs: [npmResolution.invocation.npmCliJs],
              }
            : resolveInstalledPnpmInvocation(npmResolution.invocation, controller.root);
      const resolverVerifier = packageManagerInvocation !== null
        ? new IsolatedResolverVerifier({
            packageManager: preflightProject.packageManager,
            packageManagerVersion: probePackageManagerVersion(packageManagerInvocation, controller.root),
            invocation: packageManagerInvocation,
            manifestText: preflightProject.manifestText,
            ...(preflightProject.lockfileText === null || preflightProject.lockfileName === null
              ? {}
              : {
                  lockfile: {
                    name: preflightProject.lockfileName,
                    text: preflightProject.lockfileText,
                  },
                }),
            registry: preflightProject.registry,
            policy: preflightProject.peerPolicy,
          })
        : undefined;
      const metadataProvider = new RegistryPackageMetadataProvider(
        this.options.httpClient,
        this.options.etagStore,
        preflightProject.resolvedRegistry
      );
      let analysis = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Checking compatibility for ${eligibility.packageName}@${eligibility.target}`,
          cancellable: true,
        },
        async (_progress, token) => {
          const abort = new AbortController();
          const cancellation = token.onCancellationRequested(() => abort.abort());
          try {
            return await analyzeCompatibility({
              graph,
              proposal,
              metadataProvider,
              policy: preflightProject.peerPolicy,
              ...(resolverVerifier === undefined ? {} : { resolverVerifier }),
              signal: abort.signal,
            });
          } finally {
            cancellation.dispose();
          }
        }
      );

      if (analysis.status === 'conflict') {
        const declaredByName = new Map(manifest.dependencies.map((dependency) => [dependency.name, dependency]));
        const upgradeableDirectDependencies = directNodes(graph).flatMap((node) => {
          const declared = declaredByName.get(node.name);
          if (declared === undefined || node.version === null) return [];
          return [{
            packageName: node.name,
            currentVersion: node.version,
            classification: declared.optional ? ('optional' as const) : declared.dev ? ('dev' as const) : ('prod' as const),
          }];
        });
        const planned = await planSmartUpgrade({
          graph,
          initialAnalysis: analysis,
          upgradeableDirectDependencies,
          candidateProvider: {
            getStableVersionCandidates: async (packageName, signal) => {
              const packument = await fetchPackument(
                this.options.httpClient,
                this.options.etagStore,
                registryForPackage(preflightProject.resolvedRegistry, packageName),
                packageName,
                signal
              );
              return { versions: packument.versions, complete: true };
            },
          },
          metadataProvider,
          policy: preflightProject.peerPolicy,
          ...(resolverVerifier === undefined ? {} : { resolverVerifier }),
        });
        const atomicPlan =
          planned.outcome === 'found' &&
          planned.plan.proposal.changes.every(
            (change) => change.classification === planned.plan.proposal.changes[0]?.classification
          )
            ? planned.plan
            : null;
        if (atomicPlan === null) {
          const summary = compatibilitySummary(analysis).join('\n');
          void vscode.window.showErrorMessage(
            `Upgrade blocked by dependency compatibility conflicts. Smart-plan result: ${planned.outcome}.\n${summary}`,
            { modal: true }
          );
          this.options.sink.postMessage({
            status: 'upgrade-error',
            package: eligibility.packageName,
            error: { code: 'PREFLIGHT_CONFLICT', message: 'Compatibility preflight found blocking peer conflicts.' },
          });
          return;
        }
        const coordinated = atomicPlan.proposal.changes
          .map((change) => `${change.packageName} → ${change.targetVersion}`)
          .join('\n');
        const choice = await vscode.window.showWarningMessage(
          'This upgrade requires coordinated dependency changes.',
          { modal: true, detail: coordinated },
          'Use Coordinated Plan'
        );
        if (choice !== 'Use Coordinated Plan') {
          this.options.sink.postMessage({
            status: 'upgrade-error',
            package: eligibility.packageName,
            error: { code: 'CANCELLED', message: 'Coordinated upgrade cancelled.' },
          });
          return;
        }
        proposal = atomicPlan.proposal;
        analysis = atomicPlan.compatibility;
      }

      const ignoreScripts = vscode.workspace
        .getConfiguration('dependencyDashboard')
        .get<boolean>('upgrade.ignoreScripts', true);
      const configuredVerification = vscode.workspace
        .getConfiguration('dependencyDashboard')
        .get<unknown[]>('upgrade.verificationScripts', []);
      const verificationScripts = selectVerificationScripts(source.manifestText, configuredVerification);

      const runParams = {
        packageName: eligibility.packageName,
        currentVersion: eligibility.currentVersion,
        target: eligibility.target,
        classification: eligibility.classification,
        cwd: controller.root,
        ignoreScripts,
        packageManager: source.packageManager,
        verificationScriptNames: verificationScripts.map((script) => script.scriptName),
        compatibilitySummary: compatibilitySummary(analysis),
        coordinatedChanges: proposal.changes.map((change) => ({
          packageName: change.packageName,
          target: change.targetVersion,
          classification: change.classification,
        })),
      };

      const confirmed = await confirmUpgrade(runParams);
      if (this.options.isDisposed()) return;
      if (!confirmed) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: eligibility.packageName,
          error: { code: 'CANCELLED', message: 'Upgrade cancelled.' },
        });
        return;
      }

      // A modal can remain open while project/config files change. Re-read
      // and repeat the host-owned eligibility check immediately before the
      // snapshot; the pre-modal result is never execution authority.
      const disk = await this.projectLoader(selected);
      const sourceStillMatches =
        disk.root === controller.root &&
        disk.manifestText === source.manifestText &&
        disk.lockfileText === source.lockfileText &&
        disk.lockfilePath === source.lockfilePath &&
        disk.registry === source.registry &&
        disk.packageManager === preflightProject.packageManager &&
        disk.importerId === preflightProject.importerId &&
        JSON.stringify(disk.peerPolicy) === JSON.stringify(preflightProject.peerPolicy) &&
        JSON.stringify(disk.resolvedRegistry) === JSON.stringify(preflightProject.resolvedRegistry);
      const rechecked = controller.validateUpgradeRequest(message);
      if (!sourceStillMatches || !rechecked.ok) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: eligibility.packageName,
          error: {
            code: 'STALE_SOURCE',
            message: 'Project dependency files changed while confirmation was open. Refresh and try again.',
          },
        });
        return;
      }

      const manifestPath = path.join(controller.root, 'package.json');
      const expectedLockfilePath =
        source.lockfilePath ??
        path.join(controller.root, source.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json');
      const allowlistedPaths = [manifestPath, expectedLockfilePath];
      const files = await createNodeUpgradeTransactionFileAdapter({
        workspaceRoot: selected.folder.uri.fsPath,
        allowlistedPaths,
      });

      const transaction = await runUpgradeTransaction({
        allowlistedPaths,
        files,
        install: {
          execute: async () => {
            const outcome = await this.session.run(runParams);
            return outcome.ok
              ? { status: 'succeeded' as const }
              : { status: 'failed' as const, code: outcome.code, message: outcome.message };
          },
        },
        ...(verificationScripts.length === 0
          ? {}
          : {
              verifier: {
                verify: () =>
                  this.session.verify({
                    packageName: eligibility.packageName,
                    cwd: controller.root,
                    packageManager: source.packageManager,
                    scripts: verificationScripts,
                  }),
              },
              verificationFailureDecider: {
                decide: async () => {
                  if (this.options.isDisposed()) return 'rollback' as const;
                  const choice = await vscode.window.showWarningMessage(
                    'The dependency installed, but post-upgrade verification failed.',
                    {
                      modal: true,
                      detail:
                        'Rollback restores only package.json and the active lockfile captured by this upgrade transaction; ' +
                        'it does not restore node_modules or files changed by lifecycle/verification scripts.',
                    },
                    'Rollback',
                    'Keep Changes'
                  );
                  return choice === 'Keep Changes' ? ('keep' as const) : ('rollback' as const);
                },
              },
            }),
      });

      // Reload the kept/restored/partial state while the coordinator still
      // owns the project-wide mutation lock.
      if (!this.options.isDisposed()) await this.options.reloadFinalState();
      if (this.options.isDisposed()) return;

      const presentation = describeUpgradeTransactionOutcome(
        eligibility.packageName,
        source.packageManager,
        transaction
      );
      if (presentation.kind === 'verified') {
        void vscode.window.showInformationMessage(presentation.message);
      } else if (presentation.kind === 'error') {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: eligibility.packageName,
          error: presentation.error,
        });
      } else {
        void vscode.window.showWarningMessage(presentation.message);
      }
    } catch (cause) {
      if (!this.options.isDisposed()) {
        this.options.sink.postMessage({
          status: 'upgrade-error',
          package: eligibility.packageName,
          error:
            cause instanceof CompatibilityCancelledError
              ? { code: 'CANCELLED', message: 'Compatibility preflight was cancelled.' }
              : toProtocolError(cause),
        });
      }
    } finally {
      this.session.release(eligibility.packageName);
      // Watcher events received during the lock are deferred, never dropped.
      await this.options.flushDeferredChanges();
      if (this.options.isDisposed()) this.session.dispose();
    }
  }
}
