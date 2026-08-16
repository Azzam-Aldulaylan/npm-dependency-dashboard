# Dependency Upgrade Assistant

This document records the implemented upgrade-assistant architecture and the boundaries that remain intentionally deferred.

## Implemented

- A package-manager-neutral dependency graph with explicit runtime, optional, and peer edges. npm package-lock v1/v2/v3 and pnpm lockfile v9 normalize into this model.
- On-demand compatibility preflight for exact host-validated upgrade proposals, including peer ranges, optional/missing peers, peer metadata, direct/transitive relation paths, major-version warnings, and npm/pnpm peer policy.
- Lazy exact-version registry metadata and project-independent ETag reuse. Normal dashboard opening does not fetch compatibility metadata or start resolver processes.
- Isolated npm/pnpm resolver verification. The package manager runs with structured argv, scripts disabled, bounded/redacted diagnostics, and a temporary project as its working directory.
- Bounded smart-plan search seeded only by preflight blockers. Results distinguish found, impossible, unknown, and limit-reached; reasons reference finding IDs, and cycles become coordinated atomic groups.
- A snapshot → install → verify → keep/rollback transaction. Results separately describe install, verification, rollback, and final completion.
- Exact-byte, compare-and-swap rollback for host-allowlisted files. Canonical workspace containment and symlink-component checks prevent rollback path escapes; concurrent edits are preserved as conflicts.
- Optional explicit package-script verification via `dependencyDashboard.upgrade.verificationScripts`. No application verification scripts run by default.
- npm and pnpm project/lockfile detection, pnpm v9 importer parsing, workspace link recognition, lockfile watching, manager-aware cache fingerprints, structured upgrade argv, and secure Node-driven pnpm/Corepack resolution.
- A fresh disk/config read and repeated host eligibility check after the confirmation modal, closing the stale-confirmation execution race.

## Architectural decisions

- `src/core` owns pure graph, metadata, compatibility, planning, and command-construction decisions. It never imports VS Code or starts preflight processes.
- `src/host` owns project discovery, trust checks, filesystem access, process/task execution, transaction orchestration, and user decisions.
- The webview remains presentation-only and still sends only the requested package and exact displayed target. It never supplies plan steps, commands, scripts, paths, arguments, or rollback targets.
- Peer edges never participate in advisory subtree traversal; only runtime and optional edges do.
- Resolver verification is supporting evidence, not a claim that an upgrade is universally safe. `unknown` remains distinct from compatible.
- Cancellation is honored before mutation and at stable phase boundaries. A package-manager process is not killed while it may be rewriting dependency files.
- Smart planning is deterministic and bounded. Exhausting an incomplete metadata set is `unknown`, not `impossible`.

## Known limitations

- pnpm lockfile formats before v9 are rejected rather than guessed.
- pnpm catalogs, aliases, and pnpm-specific audit enrichment are not implemented.
- Workspace-linked member manifests are not traversed as registry packages during preflight.
- Automatic coordinated execution currently requires all changes to share one dependency classification so a single atomic install/add command preserves manifest placement.
- Resolver verification can be unavailable when a trusted npm/pnpm/Corepack JavaScript entry point cannot be located. Static findings still run and the result remains explicit about incomplete evidence.
- Verification is limited to explicitly configured package.json scripts; arbitrary command strings are deliberately unsupported.
- Rollback owns only `package.json` and the active/anticipated manager lockfile. It does not attempt to restore `node_modules` or unrelated files a user script may change.

## Follow-up opportunities

- Parse older pnpm lock formats behind fixture-backed version adapters.
- Incorporate pnpm workspace member manifests and `pnpm-workspace.yaml` settings into compatibility evidence and cache invalidation.
- Add a safe multi-classification coordinated transaction by staging a host-generated manifest and asking the manager to reconcile it atomically.
- Add optional pnpm audit enrichment without changing the normalized advisory domain.
- Persist bounded project-specific compatibility results keyed by manifest, lockfile, manager version, importer, and relevant configuration fingerprints.
- Surface the structured analysis/plan/transaction history in a dedicated details view without moving resolution logic into React.
