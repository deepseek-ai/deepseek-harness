# Agent Note: Shared client control primitives

Status: implemented

English | [中文](2026-09-05-shared-client-control-primitives.zh.md)

## Problem

Client feature plugins compose through slots and never import one another's values, so `@deepseek-ai/dsh-client-ui-primitives` is their only channel for sharing a React component. A control that grows inside one feature package is invisible to the next package that needs the same thing, and copying its markup and CSS is the cheapest move available. Three families had diverged that way. A 36×20 toggle switch existed only inside `ui-settings-plugins`. Read-only capsule badges were declared five separate times across `ui-agent-preset`, `ui-settings-plugins`, and `ui-settings-plugin-inventory`, with two different corner radii and separately authored palettes. A plugin-phase status dot was reimplemented in `ui-settings-plugin-inventory` next to the shared `StateDot` it duplicates.

Neither half of the fix was available to an author. No checklist told them to look in `ui-primitives` before writing a control, and the package gave them nothing to look at: its README named six source files while the package exported more than forty symbols.

## Decision

**A control that a second client package needs lives in `ui-primitives`.** The rule is guidance for authors, not a gate: a feature package may still write its own component when its need is genuinely specific, and the [what stays local](#what-stays-local) list below records the cases from this change. What the rule forbids is the copy — when a control already exists, the author either uses it or lifts the deliberate difference into a prop.

`Tag` is the read-only capsule badge. Its geometry is fixed at the size `ui-agent-preset` established: `999px` radius, `1px 8px` padding, 11px text on a 17px line, 500 weight, `inline-flex`, no wrapping. A single closed `TagTone` union selects the palette, and every member exists because a shipped call site needed it: `outline` and `solid` from the agent-preset section, `neutral` and `quiet` from the plugin settings fields, and `success`, `info`, `warning`, and `danger` from the plugin inventory's enablement tags. The component carries no copy of its own, as every Cordis-free primitive must.

`Switch` is the two-state toggle, at the 36×20 track and 16px thumb `ui-settings-plugins` established. `label` is required and has no default, so a render site cannot omit the accessible name; `title` carries a lock reason where a deployment disables the control.

`StateDotState` gains `idle`, a static grey dot in the same halo-and-core construction as `done`, `warning`, and `error`. The plugin inventory's `pending` and `unloading` phases mean no activity is in progress, and the four existing states had no member for that; without `idle` those two phases lose their marker entirely. The addition is safe for the eight packages already consuming `StateDot` because each of them produces a `StateDotState` from its own closed status union and none switches over `StateDotState` itself.

**The component catalog in the `ui-primitives` README is what makes the rule usable.** It lists every exported component with its purpose and the case it is wrong for, and it names the three pairs that are easy to confuse: `Tag` against `Pill`, `DisclosureRow` against card-shaped disclosure, and the package-internal `FoldToggle` against the exported surface. `Pill` is the selectable capsule button — it takes `active` and `onClick` and drives view switchers and filters; `Tag` is the read-only badge and takes neither. `Pill`'s own header comment previously advertised itself for badges, which contradicted the catalog, and no longer does.

The rule is stated in [packages/client/AGENTS.md](../../../../packages/client/AGENTS.md) as the first step of the new-component checklist, and [docs/web-styling.md](../../../../docs/web-styling.md) points at the catalog so an author arriving from the styling side reaches it too.

## Finding the duplicates

A name-based search undercounts. `.badge`, `.tag`, `.chip`, and `.configTag` miss a capsule named for its role rather than its appearance — `PluginCard`'s unsaved marker is `.pending`, and its rule was byte-identical to the badge two files away. What finds them is the geometry: a CSS Modules rule carrying both `border-radius: 999px` and `padding: 1px 8px`. After this change that signature matches exactly two rules: `Tag` itself and the broken badge below. The unsaved marker keeps only a `flex: none` placement class, which the signature no longer matches.

<a id="what-stays-local"></a>
## What stays local

A mechanical search groups these controls with the promoted three. They stay in their own packages, because the grouping is superficial:

- **`ui-trajectory`'s toolbar toggle** carries `role="switch"` but is an 88px labelled control with an inline track, and it currently renders `hidden`. It is not the same widget as `Switch`.
- **`ui-schedule`'s status dot** is a static blue dot for the next run that turns amber when overdue. `StateDot` has no static blue — its only blue is `ongoing`, an animated pixel matrix — and one animation per row in a schedule list would misstate the meaning as well as the appearance.
- **`ui-plan`'s mode chip** and **`ui-conversation`'s `ReferenceChip`** are interactive: the first is a warning-toned button with hover, focus, disabled, and a close affordance; the second is a Lexical atom node with its own truncation. Neither is a read-only badge.
- **`ui-trajectory`'s cell tag** and **`ui-user-questions`'s recommendation badge** use their own geometry — a 6px radius at table density, and a 6px radius at 600 weight on the sidebar accent. Forcing either into the capsule baseline would change a deliberate design, not an accidental one.
- **`TerminalBlock`'s exit-status pill** stays a static `Pill`. It sits on a 24px command line at the pill's own geometry, and `Tag`'s 11px capsule would not fit that row. The read-only/selectable split is the usual guide, but size decides this one, and the catalog says so.
- **`ui-agent-preset`'s broken badge** shares the capsule geometry but carries a solid error fill that no second site uses, and it is the hover anchor for a tooltip element of its own. `Tag` would have to keep a palette override in the feature stylesheet and depend on cross-file CSS ordering to win it.

## Alternatives considered

**A `SettingsCard` primitive.** Rejected. `.card` appears in fifteen packages, but only three carry settings-page semantics, and those three differ in behaviour rather than appearance: `ui-settings-plugins`' `PluginCard` stages edits and collapses only after a Host-confirmed save, `ui-agent-preset`'s cards are selectable, and the plugin inventory's are read-only. `PluginCard`'s own header comment already records why it cannot use the shared disclosure row. A single component would have to accept all three behaviours through props that no caller uses more than one of.

**A gate rejecting `role="switch"` or a `.switch` rule outside `ui-primitives`.** Rejected. The goal is that authors reuse what exists, not that they are prevented from building. A gate would fail a package with a legitimately specific control — `ui-trajectory`'s labelled toolbar toggle is exactly that case — and the cost of the false rejection lands on the author least able to argue with it. The catalog plus the checklist step address the actual failure, which is that authors did not know the control existed.

**Preserving every current appearance behind extra `Tag` props.** Rejected. The plugin inventory's 5px radius and the agent-preset capsule are the same kind of tag in two shapes, and neither difference was decided. Keeping both would fix an accident into a public union and leave the next author to guess which one to pick.

**Extending `Pill` instead of adding `Tag`.** Rejected. `Pill` is 24px tall on a 12px radius with 12px text; the badge baseline is denser and rounder. Merging them would produce one component whose size depends on whether `onClick` is present, and would erase the read-only/selectable distinction that the catalog needs in order to answer "which one do I want".

**A two-axis `variant × tone` API for `Tag`.** Rejected. Three variants against six tones describes eighteen combinations of which eight ship, and it lets a caller request combinations with no defined appearance. The flat eight-member union maps each value to exactly one shipped appearance.

**Rendering no dot for `pending` and `unloading` instead of adding `idle`.** Rejected. Those rows show a grey dot today, and dropping it would remove information from the inventory in a change whose purpose is to consolidate presentation.

**Putting the reuse rule in the root `AGENTS.md`.** Rejected. The rule governs `packages/client` alone, and the root file sits exactly at its 1950-word ceiling in `scripts/doc-budgets.manifest.json`, so stating it there would have to displace an unrelated repository-wide rule.

## Testing

`Tag`, `Switch`, and the extended `StateDot` carry component specs in `packages/client/ui-primitives/tests`, inside the per-file 100% coverage gate. `StateDot`'s palette is pinned by reading its stylesheet: CSS Modules resolve to class-name maps in the component suites, so a state whose color rule is missing renders on the inherited color and no render assertion notices.

The migrated render sites keep their existing package specs unchanged. The web e2e goldens are ARIA snapshots, and the full replayed web suite passes without re-recording, because the migration preserves every role, accessible name, and state — `Switch` keeps `role="switch"` with `aria-checked`, and the inventory's phase dot keeps its `role="img"` name on a wrapper, since `StateDot` is `aria-hidden`.

That is also the limit of the automated evidence. No gate in this repository compares pixels, so the capsule geometry, the dot halo, and the font-weight change are verified by review against the light and dark screenshots in the pull request.

## Consequences

- A new client control now has one place to check and one place to add, and the catalog makes the check a single file read rather than a `grep` over forty exports.
- `TagTone` is eight members wide because eight appearances shipped. Adding a ninth requires a render site that needs it, not a symmetry argument.
- The plugin inventory's tags change from a 5px rectangle to a capsule, and the disabled tag's fill moves from `--dsw-alias-bg-layer-1` to the `neutral` tone's `--dsw-alias-bg-module-platform`, which is a visible grey where it used to be near-transparent. Its phase dots gain a halo and animate through `loading` and `unloading`. The unconfigured-secret badge in the plugin settings fields moves from 400 to the baseline 500 weight. These are deliberate visual changes, recorded here so a later reader does not treat them as regressions.
- The migration removes a literal `#b45309`. The plugin inventory's `conditional` tag read `var(--dsw-alias-state-warning-primary, #b45309)`, and no such alias exists — the real token is `--dsw-alias-state-warn-primary` — so both themes had been painting the hardcoded fallback that [docs/web-styling.md](../../../../docs/web-styling.md) forbids.
- The rule cannot be checked mechanically. A future author can still copy a control, and only review will catch it. That is the accepted cost of not gating: the alternative rejects legitimate work, and the packages that stay local above are proof that legitimate work exists.
- `ui-primitives` grows two components that one package each consumes today. The switch in particular is a single-consumer primitive, promoted because it is a general control and because the plugin-management work already in flight will adopt it rather than adding two further copies.
