# Smart Cleanup --- Product & Business Feature Brief

## Purpose

Smart Cleanup should become one of the primary actions in the dependency
dashboard: a guided workflow that answers a simple question for the
developer:

> **What dependency clutter can this project safely reduce, and what
> will improve if I clean it up?**

The feature should turn several existing dependency-health signals into
one understandable cleanup journey. It should not feel like a collection
of unrelated warnings, nor should it force the user to manually
investigate every package before acting.

The core product promise is **less dependency clutter, lower avoidable
risk, and a clearer project state --- with evidence before the change
and measurable results afterward.**

------------------------------------------------------------------------

## Product Positioning

Smart Cleanup should be treated as a flagship workflow rather than
another dashboard filter.

The dashboard can surface **Smart Cleanup** as a prominent primary
action. When invoked, the extension analyzes the selected project and
prepares a cleanup plan. The user reviews the plan, understands why each
action is proposed, and can execute the approved cleanup as one guided
operation.

The experience should optimize for:

-   confidence rather than aggressive removal;
-   useful automation rather than manual dependency housekeeping;
-   concise summaries with details available on demand;
-   measurable before/after value;
-   reversibility when changes do not work as expected.

------------------------------------------------------------------------

## The Cleanup Journey

### 1. Start Smart Cleanup

The user selects **Smart Cleanup** from the dashboard.

A focused cleanup workspace/modal opens and immediately begins analyzing
the project. The loading experience should make it clear that several
cleanup opportunities are being evaluated rather than presenting a
generic spinner.

The user should not have to understand dependency-tree terminology
before receiving useful results.

### 2. Present a Compact Cleanup Summary

Once analysis finishes, show only the most important categories at the
top.

Recommended primary summary:

  -----------------------------------------------------------------------
  Category                            What the user learns
  ----------------------------------- -----------------------------------
  **Unused**                          Dependencies that appear
                                      unnecessary and are candidates for
                                      removal

  **Deprecated**                      Dependencies that are no longer
                                      recommended or maintained by their
                                      publisher

  **Duplicate Versions**              Packages appearing in multiple
                                      versions where consolidation may be
                                      possible

  **Security Impact**                 Vulnerabilities expected to
                                      disappear or improve as a result of
                                      the proposed cleanup
  -----------------------------------------------------------------------

Also show one concise overall outcome such as:

**8 cleanup opportunities · 4 packages removable · 2 duplicate versions
potentially consolidatable**

Avoid turning the summary into a large analytics dashboard. Its job is
to tell the user whether cleanup is worthwhile.

### 3. Expand for Evidence

Every summary category should be expandable.

For example, expanding **Unused** can reveal the packages classified as
unused and useful context already known about each package, such as
vulnerability status or other relevant risk information.

Expanding **Duplicate Versions** should show which package has multiple
versions and why consolidation is being proposed.

Expanding **Deprecated** should identify the affected dependencies and
explain the status without implying that deprecation automatically means
removal is safe.

This progressive-disclosure approach keeps Smart Cleanup approachable
while still giving advanced users enough evidence to trust the plan.

### 4. Review the Proposed Cleanup

Before anything changes, Smart Cleanup should clearly state what it
intends to do.

The review should answer:

-   What will be removed?
-   What will be consolidated or changed?
-   Which findings are informational only?
-   Why is each action considered appropriate?
-   What improvements are expected?
-   Which decisions remain uncertain or require user review?

The user should be able to exclude individual proposed actions without
abandoning the entire cleanup.

### 5. Execute as One Guided Cleanup

After confirmation, Smart Cleanup performs the approved actions as a
coherent cleanup operation rather than forcing the user through several
unrelated workflows.

Progress should be visible. The user should understand which stage is
currently running and which cleanup actions have completed, failed, been
skipped, or require attention.

### 6. Show the Result

After cleanup, replace the planning view with a concise **Before →
After** report.

Examples of useful outcomes:

-   dependencies before → dependencies after;
-   direct dependencies removed;
-   duplicate versions consolidated;
-   deprecated dependencies removed or otherwise addressed;
-   vulnerabilities before → vulnerabilities after;
-   cleanup actions completed / skipped / failed;
-   dependency health improvement, if the product has an explainable
    health metric.

The report should emphasize **verified outcomes**, not estimates
presented as facts.

------------------------------------------------------------------------

# Cleanup Opportunity Types

## 1. Unused Dependencies

This is the clearest initial cleanup opportunity.

Smart Cleanup should identify dependencies that appear unused and then
apply the project's existing safety knowledge before recommending
removal.

The product should distinguish between:

-   **Safe candidate** --- strong evidence supports removal;
-   **Review required** --- there are signals that make automatic
    removal uncertain;
-   **Not removable / blocked** --- the project still requires the
    dependency;
-   **Unknown** --- the extension cannot establish enough confidence.

A package should never be removed simply because a basic source scan did
not find an import.

### User value

Unused dependency cleanup can reduce maintenance burden, remove
unnecessary security exposure, simplify manifests, and make future
dependency reviews easier.

------------------------------------------------------------------------

## 2. Deprecated Dependencies

Deprecated packages belong in Smart Cleanup because they represent
dependency debt, but **deprecated does not mean unused**.

The cleanup experience should therefore distinguish between:

-   deprecated **and unused** --- potentially removable;
-   deprecated **and still used** --- requires remediation rather than
    blind removal;
-   deprecated with a known successor/replacement --- useful
    recommendation opportunity;
-   deprecated with no confident migration path --- surface it without
    pretending Smart Cleanup can safely solve it automatically.

### Product principle

Smart Cleanup should expose deprecated dependencies as cleanup
opportunities, but only automate an action when the evidence supports
that action.

------------------------------------------------------------------------

## 3. Duplicate Versions

A duplicate-version finding means multiple versions of the same
underlying package exist in the dependency graph.

This can increase dependency-tree size and maintenance complexity.
However, the presence of two versions does **not** automatically mean
one can be deleted or that everything should use the newest version.

Smart Cleanup should evolve duplicate detection from:

> **"This package exists in multiple versions."**

into:

> **"These versions can/cannot reasonably be consolidated, and here is
> why."**

### Choosing a consolidation direction

Do **not** establish a static rule such as:

-   always upgrade the lower version; or
-   always downgrade the higher version.

The preferred outcome should be the **lowest-risk compatible convergence
point**.

From the user's perspective, Smart Cleanup should explain the decision
in plain language, for example:

> **Recommended: consolidate on 4.2.1**\
> Compatible with both dependent packages and avoids a major-version
> change.

or:

> **Keep both versions**\
> The packages that require them do not currently share a compatible
> version range.

If consolidation would require broader package upgrades, that should be
made explicit rather than disguised as simple cleanup.

### Important boundary

Sometimes duplication is legitimate. Smart Cleanup earns trust by being
willing to say **No safe cleanup available**.

------------------------------------------------------------------------

## 4. Direct + Transitive Presence

A package can be declared directly by the project while also being
installed transitively through another dependency.

This must **not** automatically be treated as redundant.

If the application imports or otherwise relies on that package directly,
keeping it as a direct dependency correctly declares the application's
dependency contract --- even if another installed package happens to
bring the same package transitively today.

Therefore Smart Cleanup should not make the simplistic assumption:

> "Package A also exists under Package B, so remove direct Package A and
> use B's copy."

That could make the application accidentally depend on Package B's
internal dependency choices and break later if B changes its dependency
tree.

The product should only propose removing a direct declaration when there
is strong evidence that the project itself does not depend on it
directly and removal is otherwise safe.

This distinction is essential to the credibility of Smart Cleanup.

------------------------------------------------------------------------

## 5. Vulnerability Reduction

Security improvement should be an **outcome of cleanup**, not an excuse
to perform unsafe cleanup.

Smart Cleanup should calculate which known vulnerabilities are expected
to disappear because of approved actions such as removing an unused
vulnerable dependency or successfully consolidating/changing
dependencies.

Examples:

**Security Impact**\
3 vulnerabilities expected to be removed\
1 Critical · 2 Moderate

After execution, the report should use the actual post-cleanup state:

**Vulnerabilities**\
7 → 4\
3 resolved

If a proposed cleanup does not improve security, there is no need to
manufacture a security benefit.

------------------------------------------------------------------------

# What Smart Cleanup Should NOT Do

To keep the first version trustworthy, avoid turning Smart Cleanup into
an unlimited dependency migration engine.

It should not:

-   remove a dependency solely because no simple import was detected;
-   assume every duplicate version should be consolidated;
-   always prefer the newest package version;
-   always prefer the oldest/common version;
-   automatically replace a direct dependency with another package's
    transitive copy;
-   claim application functionality is unaffected when that cannot be
    proven;
-   automatically rewrite application source code simply to make a
    cleanup possible;
-   recommend alternative libraries without strong evidence and a clear
    migration story;
-   present estimated bundle-size savings as verified savings;
-   mix unrelated feature upgrades into a cleanup without clearly
    telling the user.

Smart Cleanup should prefer **"review required"** or **"no safe cleanup
available"** over false confidence.

------------------------------------------------------------------------

# Before/After Value

The completion report is important because it turns cleanup into a
visible product outcome.

## Recommended headline metrics

Keep the default report small. Prefer metrics that are meaningful and
reliably measurable:

### Dependencies

**126 → 119**\
7 direct dependencies removed

### Duplicate Versions

**11 → 7**\
4 duplicate versions consolidated

### Vulnerabilities

**8 → 5**\
3 vulnerabilities resolved

### Cleanup

**12 proposed → 11 completed**\
1 skipped

If a dependency-health score is introduced, it can appear here as long
as the score is transparent and explainable:

**Dependency Health**\
78 → 86

The user should be able to expand the report to see exactly which
actions produced each improvement.

------------------------------------------------------------------------

# Size Savings

Size reduction is attractive but needs careful product wording.

There are several different concepts that users may interpret as "size":

-   dependency installation footprint;
-   lockfile/manifest changes;
-   application bundle size;
-   production deployment size.

These are not interchangeable.

For the first version, show a size metric only when the extension can
measure it reliably and label exactly what was measured. Do not claim
bundle-size savings merely because a dependency was removed from the
dependency tree.

If reliable size measurement is not ready, omit it from v1 rather than
weakening trust in the rest of the report.

------------------------------------------------------------------------

# Rollback and Confidence

Smart Cleanup should reuse the product's existing rollback/restore-point
concept so cleanup feels reversible.

The UI does not need a large rollback section. A concise message near
the final action is enough:

> **A restore point will be created before cleanup. You can rollback if
> something goes wrong.**

After cleanup, rollback should remain discoverable for the completed
operation according to the product's existing rollback behavior.

The implementation details should be decided by the technical agent
after reviewing the current rollback architecture rather than duplicated
specifically for Smart Cleanup.

------------------------------------------------------------------------

# Explainability

Every automated cleanup recommendation needs a short **Why?**

Examples:

**Remove `package-a`**\
No project usage found and no required dependency relationship detected.

**Consolidate `package-x` on 4.2.1**\
Both dependents support this version; consolidation removes one
duplicate installation.

**Keep both versions of `package-y`**\
Current dependents do not have a compatible shared version.

**Review `package-z`**\
Deprecated, but still used by the application.

The user should not need to understand the analyzer's implementation to
understand the recommendation.

------------------------------------------------------------------------

# Confidence Model

Smart Cleanup should conceptually separate findings by confidence even
if the exact UI wording changes later.

### Safe

Strong evidence supports the proposed cleanup and the action can be
offered normally.

### Review Required

There is a useful cleanup opportunity, but the evidence does not justify
silent automation.

### Blocked

The proposed cleanup would violate a known dependency requirement or
other deterministic safety condition.

### Unknown

Analysis is incomplete or cannot establish a safe conclusion.

This prevents Smart Cleanup from becoming an overly aggressive "delete
things" button.

------------------------------------------------------------------------

# Suggested v1 Scope

The first release should be ambitious enough to feel smart without
trying to solve every form of dependency debt.

## Include

1.  One prominent **Smart Cleanup** entry point.
2.  Analysis/loading experience.
3.  Unused dependency candidates with safety classification.
4.  Deprecated dependency findings.
5.  Duplicate-version findings.
6.  Safe consolidation recommendations where confidence is sufficient.
7.  Security impact derived from the proposed cleanup.
8.  Compact summary with expandable evidence.
9.  Per-action inclusion/exclusion before execution.
10. One guided cleanup execution.
11. Existing rollback/restore-point protection reused where appropriate.
12. Before/after completion report.

## Defer unless already easy with existing capabilities

-   automatic migration to alternative libraries;
-   broad source-code rewrites;
-   speculative bundle-size savings;
-   aggressive forced version overrides;
-   automatically resolving every duplicate version;
-   general dependency modernization unrelated to cleanup.

------------------------------------------------------------------------

# Success Criteria

Smart Cleanup succeeds when a developer can open a project and, within
one workflow:

1.  understand whether meaningful dependency cleanup is available;
2.  understand **why** each cleanup is being proposed;
3.  distinguish safe actions from uncertain ones;
4.  approve or exclude individual actions;
5.  execute the cleanup without manually coordinating several tools;
6.  see a verified before/after result;
7.  recover through the existing rollback model if necessary.

The feature should leave the developer thinking:

> **"I removed dependency debt I would otherwise have ignored, and I
> understand exactly what changed."**

------------------------------------------------------------------------

# Guidance for the Technical Implementation Agent

This document intentionally defines the **product behavior and business
intent**, not the architecture.

Before implementation, the technical agent should inspect the latest
repository and produce an implementation plan that identifies:

-   which existing analyzers and workflows can be reused;
-   what capabilities are already implemented versus missing;
-   where duplicate logic must be avoided;
-   how existing removal, verification, transaction, and rollback
    capabilities should participate;
-   what additional analysis is required for safe duplicate-version
    consolidation;
-   how npm and pnpm behavior differs;
-   performance implications of the complete cleanup analysis;
-   test strategy and rollout stages.

The technical design should follow the current codebase rather than
forcing the codebase to match assumptions in this brief.

------------------------------------------------------------------------

## Product Principle

**Smart Cleanup should automate what the extension can justify, explain
what it recommends, and refuse to pretend certainty where dependency
behavior is uncertain.**
