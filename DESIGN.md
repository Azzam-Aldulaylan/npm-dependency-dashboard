---
name: "Dependency Dashboard — Main Dashboard"
description: "Dense, theme-native project health and dependency inventory. Scope: main dashboard only."
colors:
  foreground: "var(--vscode-foreground)"
  muted: "var(--vscode-descriptionForeground)"
  canvas: "var(--vscode-editor-background)"
  surface: "var(--dashboard-surface)"
  surface-raised: "var(--dashboard-surface-raised)"
  line: "var(--dashboard-line)"
  line-strong: "var(--dashboard-line-strong)"
  accent: "var(--dashboard-accent)"
  total: "var(--accent-total)"
  updates: "var(--accent-updates)"
  vulnerabilities: "var(--accent-vulnerabilities)"
  attention: "var(--accent-attention)"
  primary-background: "var(--vscode-button-background)"
  primary-foreground: "var(--vscode-button-foreground)"
  primary-hover: "var(--vscode-button-hoverBackground)"
typography:
  title:
    fontFamily: "var(--vscode-font-family)"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  section:
    fontFamily: "var(--vscode-font-family)"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  body:
    fontFamily: "var(--vscode-font-family)"
    fontSize: "var(--vscode-font-size)"
  metric:
    fontFamily: "var(--vscode-font-family)"
    fontSize: "1.55rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.03em"
rounded:
  panel: "12px"
  health-group: "10px"
  search: "8px"
  inventory-control: "7px"
  filter-option: "5px"
  pill: "999px"
spacing:
  panel-inset: "1rem"
  compact-inset: "0.75rem"
components:
  button-primary:
    backgroundColor: "{colors.primary-background}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.inventory-control}"
    padding: "0.35rem 0.9rem"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-manage:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.inventory-control}"
  search:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.search}"
    padding: "0.45rem 2.15rem 0.45rem 2.25rem"
---

# Design System: Main Dashboard

## Overview

**Creative North Star: "The Technical Inventory"**

MAIN DASHBOARD ONLY. A dense, Linear-inspired technical workspace expressed through the incumbent VS Code theme, not a fixed Linear palette. Restrained type, hairline divisions, and tonal surfaces keep project health readable above a separate working inventory.

This document records the existing dashboard implementation. Its composition is not a template or requirement for Manage Dependency, Smart Cleanup, or other modal workspaces; those retain their own layout and safety boundaries.

**Key Characteristics:**

- Theme-native semantic color and system UI typography.
- Four health signals grouped as one surface.
- Separate inventory with labeled filters and local table scrolling.
- Quiet, consistent row actions and explicit selection cues.

Source of truth: `webview/src/styles.css`, the dashboard and header in `webview/src/App.tsx`, and `SummaryCards.tsx`, `DashboardToolbar.tsx`, `DependencySearch.tsx`, and `PackageTable.tsx` under `webview/src/components/`.

## Colors

The active VS Code theme owns the palette; frontmatter preserves live CSS variable references rather than freezing theme-dependent colors.

### Primary

- **Focus accent:** identity detailing, keyboard focus, and selected inventory filters.
- **Native primary pair:** primary actions use the button background and button foreground together; hover uses the native button hover background.
- **Health signals:** total, updates, vulnerabilities, and attention use their corresponding chart-derived semantic accents. Severity and warning colors remain meaningful, not decorative.

### Neutral

- **Canvas / surface / raised surface:** editor background, subtly mixed main panels, and subtly mixed controls and grouped signals.
- **Foreground / muted:** primary content versus supporting context.
- **Line / strong line:** panel divisions versus control boundaries and table-header separators.

The dashboard aliases are defined in the stylesheet using `color-mix()` and VS Code variables. Keep those definitions authoritative; do not synthesize fixed tonal ramps or substitute branded hex colors.

**The Native Pair Rule.** Preserve the native primary foreground/background contrast pair when changing primary action styling.

## Typography

Use the VS Code-provided system UI family throughout this dashboard; there is no separate display face. The compact hierarchy is title, section heading, body, and small supporting labels, with tabular numerals for metrics, timestamps, and matching counts.

The frontmatter records the title, section, body, and metric roles. Selected metrics increase to bold (700). Supporting copy commonly uses (0.78em); health labels use (0.74em) with semibold weight (600). Keep vulnerability totals and severity breakdowns on separate wrapping lines, not truncated into one line.

## Layout

The wrapping header pairs project identity with search. Below it, project health occupies one bordered panel; inventory occupies another with heading, filter/action toolbar, table, and pagination. Main insets follow the panel and compact spacing tokens.

- Wide view: four equal health columns; filters and actions share a wrapping toolbar.
- At (680px) and below: two health columns, full-row search, and separate full-width toolbar leading/action rows.
- At (420px) and below: one health column, stacked section context, full-width labeled filter groups, stacked actions, and stacked pagination. Secondary project metadata is hidden.
- The inventory table retains a minimum width of (58rem), fixed column layout, and its own horizontal/vertical overflow. Its bounded viewport uses `max-height: min(68vh, 48rem)`; short tables keep natural height.
- Sticky column headers remain inside the keyboard-focusable table region. Pagination sits outside that scrolling region. Long package names and version strings wrap rather than expanding the page.

## Elevation & Depth

Depth is flat and tonal: thin borders, neutral surface changes, and low-percentage semantic tints. There are no lifted panel shadows. Existing inset strokes distinguish selected segmented filters and sticky table headers; they are outlines/separators, not an elevation scale.

State changes remain restrained: health and segmented-filter colors transition over (150ms) with ease; disclosure rotation uses (0.1s). Do not extrapolate these into a new motion system.

## Shapes

Main panels use the panel radius. Health signals share a single rounded outer group and square internal divisions, not four floating cards. Search and inventory controls use the smaller recorded radii; timestamps and the small “Viewing” indicator are pills. Preserve the hierarchy of containing surface, grouped controls, and compact internal elements.

## Components

### Health signals

Four semantic buttons: Total Dependencies, Updates Available, Vulnerable Dependencies, and Needs Attention. Selection combines a subtle tint, a bottom underline, a visible “Viewing” marker, and `aria-pressed`; color is not the sole cue. Each button's accessible label includes its count and supporting context. Keyboard focus has a visible inset outline.

**The Filter, Not Navigation Rule.** Health selection and search filter the inventory in place. They do not move keyboard focus or scroll the user to the table.

### Search and filters

Search is a real labeled input with a labeled clear button and visible focus treatment. It matches package names and host-issued vulnerability identifiers, titles, packages, and dependency paths against existing rows; typing does not initiate scans or network requests.

Dependency type and Findings remain visibly labeled, distinct segmented filter groups. Selected options use tonal fill plus an inset stroke; focus remains visible. The inventory's polite live count explains matching results without duplicating another count in the toolbar.

### Actions

Smart Cleanup is the native primary dashboard action. Manage dependencies and Change project are quieter secondary actions; Refresh is subtle. Maintain their existing disabled conditions.

Every package gets the same quiet “Manage” action with foreground text, a raised neutral surface, and a strong boundary. Do not imply upgrade eligibility or safety through differently styled row buttons. Package-name interaction and Manage retain their existing destinations and modal boundaries.

### Inventory and states

The table preserves sortable headers, disclosures, semantic status information, row-group hover, and visible keyboard focus. Maintain partial-result notices, cached/stale context, unavailable-data distinctions, loading behavior, and query/filter empty states. A visual change must not reclassify unknown data as zero, hide valid partial inventory, or bypass host-owned eligibility and safety rules.

## Do's and Don'ts

### Do:

- **Do** preserve theme-variable sources and the native primary contrast pair.
- **Do** retain grouped health signals, explicit non-color selection cues, labeled filters, and separate inventory.
- **Do** keep overflow local to the table and pagination outside it.
- **Do** preserve keyboard behavior, stale/partial information, action eligibility, and modal safety boundaries.

### Don't:

- **Don't** impose this dashboard composition on Manage Dependency or Smart Cleanup.
- **Don't** add fixed brand colors, floating panel shadows, decorative typography, or a new motion vocabulary.
- **Don't** turn signal selection or search into focus/scroll navigation.
- **Don't** style identical Manage actions as competing severity or upgrade-status buttons.
