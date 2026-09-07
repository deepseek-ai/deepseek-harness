# Agent Note: Local JSON tree renderer

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-28-local-json-tree-renderer.zh.md)

## Problem

The read-only JSON inspector used by the [trajectory ledger](../feature/2026-07-27-trajectory-inspection-ledger.md) needs compact object and array previews, explicit array paths for copy actions, fixed-open and collapsible root modes, and keyboard navigation. `react-json-view-lite` exposes neither custom node rendering nor row identity, so satisfying those requirements through that dependency requires a package-manager patch against compiled distribution files and DOM traversal that reconstructs data paths from visible labels. The patch behaves as an untyped fork while its source maps and upstream source remain unchanged.

## Decision

`JsonTree` owns its recursive presentation in `dsh-client-ui-primitives`.

- Each rendered row receives its value and property path directly. Object keys and array indexes extend that path during recursion, so copy actions never recover application data from rendered DOM text.
- Expandable rows render the compact preview locally and mount child rows only while expanded. `expandTopLevel` selects between a fixed-open bracket frame and a collapsible root node without changing the public component contract.
- The tree keeps one tabbable expander among visible nodes. Pointer activation claims that tab stop; Up and Down move it cyclically, while Left and Right collapse or expand the focused node.
- `react-json-view-lite` is not a package dependency and has no pnpm patch. Focused component tests pin previews, expansion, keyboard focus, and array copy paths.

## Alternatives considered

**Keep the distribution patch.** Rejected because the application-specific renderer and array identity contract would remain hidden in generated third-party files, and every dependency update would require reviewing a fork without matching source maps.

**Use the upstream renderer without previews.** Rejected because `{…}` and `[…]` discard the compact payload context that the trajectory inspector uses for scanning.

**Inject previews and row metadata after render.** Rejected because effects or mutation observers would depend on the same private DOM structure while splitting one row between React ownership and imperative mutation.

**Adopt a larger JSON viewer.** Rejected because editing, search, and theme systems are outside the current read-only contract; the added dependency surface would not remove the inspector-specific copy and layout code.

## Consequences

The JSON inspector has one source-level owner, explicit data flow, accurate array paths, and no patched dependency. The package now owns recursive rendering, expansion state, ARIA tree structure, and roving focus behavior, so changes to those semantics require focused component coverage. The implementation remains intentionally read-only and limited to the preview, navigation, and copy behavior used by current consumers.
