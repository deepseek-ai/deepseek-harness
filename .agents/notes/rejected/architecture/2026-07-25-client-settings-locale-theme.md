# Agent Note: Client Settings, Locale, and Theme layering

Status: rejected — closed as a proposal: the shipped ui-settings, locale, and ui-theme packages and their READMEs own the design

English | [中文](2026-07-25-client-settings-locale-theme.zh.md)

## Problem

The browser client's existing Settings is written directly inside the Sidebar, and language and theme are applied by component-local state mutating the DOM directly. As a result Settings cannot be extended by independent plugins, preference state has no stable cross-plugin service contract, and the theme registry carries both state and presentation responsibilities.

## Proposal

**Collaboration doctrine (how every later module joins Settings): feature owners self-register.** The Settings shell is a pure composition surface: it only declares slots and renders the chrome structure — zero copy, no locale dependency, and neither importing nor enumerating any feature; for a feature to appear in Settings, its own plugin registers into the corresponding slot — locale registers the Language row, ui-theme registers the Appearance row, ui-settings-models registers the Models top-level panel. No separate `ui-settings-*` package is created for "a feature's settings page": the settings surface belongs to the feature package itself (shipping the Theme feature means Theme's settings choices ship with ui-theme). Content that belongs to no single feature (the trigger/title/close chrome copy, the General directory with its skeleton rows, the `settings` dictionary) is owned by `ui-settings-general` — the owner of the ownerless copy, not a feature satellite package.

The Sidebar declares the `sidebar.settings` single slot; `ui-settings` occupies it and declares four slots: `settings.trigger` / `settings.header` / `settings.close` (chrome content seats, single) and `settings.section` (top-level pages, list). Accessible names all resolve from slot content: the trigger's accessible name is its text content, the dialog points at the header content node via aria-labelledby, and close is a visually hidden text seat. Each section is contributed by a feature plugin; the shell only reads entry metadata from the slot ledger to build the navigation, rendering the current section via `only`. General is registered by `ui-settings-general` (order 0) and declares the `settings.general.item` list slot, into which the feature plugins' preference rows slot by order.

The Settings entry is the Settings row in the sidebar Foot; clicking it directly opens a 1080×700 centered overlay (black 24% mask); the close button, a mask click, and ESC all close it. There is no intermediate menu form of any kind.

`@deepseek-ai/dsh-client-locale` provides `ctx.locale`; `ui-theme` provides `ctx.theme`. Both services read through a getter, write through a setter, and publish immutable snapshots via typed Cordis change events; each service persists its own preference (storing only the id, with bad values falling back to the default).

Each feature row's apply layer subscribes to its own change event (locale to `locale/change`, ui-theme to `theme/change`) and projects the snapshot into the slot store declared when that row registered. React components only read `useStore` and write through the injected setter callbacks, never reading ctx or the services.

The theme preference has three states — `light`, `dark`, `system` — defaulting to `system` (when no persisted preference exists or the value is bad). Resolving system belongs to the theme domain: ThemeRuntime holds the `prefers-color-scheme` matchMedia listener (environment sensing, not DOM presentation) and re-emits the snapshot when the preference is system and the system color scheme changes; the snapshot carries both `preference` and the resolved `active` definition.

The theme service never touches the DOM. `ui-layout` reads the Theme getter initially and then subscribes to `theme/change`; the presenter owned by Layout updates `body[data-ds-dark-theme]` and the theme tokens according to `active`. The presenter has no notion of system — it consumes only resolved results.

### First-phase registration surfaces

| Registration surface | Owning plugin | First-phase content |
|---|---|---|
| chrome content (trigger/header/close) | `ui-settings-general` | Settings entry-row icon and copy, panel title, close hidden text |
| General section (order 0) | `ui-settings-general` | Permission and Tool Call visual skeletons (no write operations) plus the `settings.general.item` slot declaration |
| Language row (item order 0) | `locale` | Selector dropdown; 中文/English genuinely switch |
| Appearance row (item order 10) | `ui-theme` | Light/Dark/System three cubes genuinely switch (the selected state reflects preference) |
| Models section (order 10) | `ui-settings-models` | Navigation item only, with an empty content area; later model-management features land in that package |
| Plugin | none | Not built this phase, and the navigation does not show the item (once a later plugin feature package registers the section it appears automatically) |

The first phase localizes only the copy inside the Settings overlay; dictionaries stay close to their owners — the chrome plus the General skeletons live in `ui-settings-general`'s `settings` namespace, and feature-row copy lives in each feature package (`settings.locale`, `settings.theme`, `settings.models`).

### Slot topology

```text
root
└─ sidebar
   └─ sidebar.settings                   single/root
      └─ ui-settings（壳，零文案）
         ├─ settings.trigger             single/root  ui-settings-general 注册
         ├─ settings.header              single/root  ui-settings-general 注册
         ├─ settings.close               single/root  ui-settings-general 注册
         └─ settings.section             list/root
            ├─ general (order 0)         ui-settings-general 注册
            │  └─ settings.general.item  list/root
            │     ├─ language (0)        locale 注册
            │     └─ appearance (10)     ui-theme 注册
            └─ models (order 10)         ui-settings-models 注册
```

Section and item contributions use `ctx.slots.inject()` and do not depend on the client manifest's apply order; localized labels ride the label thunk from the [full-rollout note](../../archived/architecture/2026-07-30-client-locale-full-rollout.md). The SlotMap types split homes: trigger/header/close/section have their canonical home in the ui-settings contract (the consumers, general and models, both depend on the shell — no cycle); `settings.general.item`'s canonical home is the locale package — it is the lowest common dependency of all item registrants (a settings row always carries copy), while the declarer general's contract is unreachable from locale/ui-theme (it would form a cycle); ui-theme consumes it through a re-export outlet.

### Slot declarations are first-class injectable waits

`SlotRegistry.inject()` now waits on the typed ledger key directly; it does not bridge declarations into synthetic `slot:<name>` Cordis services. The callback follows declaration collapse and redeclaration while its controller remains owned by the contributing plugin fiber, and direct registration into an undeclared slot still fails loud. This removes the stale-disposer presence machine and the typo-prone parallel service namespace. The complete lifecycle and failure contract lives in the [slot declaration injection decision](../../archived/architecture/2026-08-05-slot-declaration-injection.md).

### Service contracts

```ts
export type ThemePreference = 'light' | 'dark' | 'system'

export interface ThemeDefinition {
  id: string
  colorScheme: 'light' | 'dark'
  tokens: Record<string, string>
}

export interface ThemeSnapshot {
  preference: ThemePreference
  active: ThemeDefinition            // system 已解析为具体 light/dark 定义
  themes: readonly ThemeDefinition[]
  revision: number
}

export interface LocaleDefinition {
  id: 'zh' | 'en'
  label: string
}

export interface LocaleSnapshot {
  active: 'zh' | 'en'
  locales: readonly LocaleDefinition[]
  revision: number
}

export interface Events {
  /** @param snapshot - Current locale registry snapshot. @mode emit */
  'locale/change'(snapshot: LocaleSnapshot): void
  /** @param snapshot - Current theme registry snapshot. @mode emit */
  'theme/change'(snapshot: ThemeSnapshot): void
}
```

Locale ships with 中文 and English built in; `setLocale`/`setTheme` are the only write entry points, and an unknown id fails.

## Alternatives considered

**Having the app shell subscribe to preferences centrally and re-render the root slot tree.** A language or theme change only needs to update the actual consumers; a whole-tree refresh amplifies the blast radius and wires business preferences into the shell.

**The theme service mutating the DOM directly.** The registry service would then depend on the presentation environment, with unclear lifecycle and global-style ownership; Layout already owns the page-root presentation boundary.

**Resolving system in the Layout presenter.** The presenter would need its own matchMedia subscription and would pick the concrete definition out of the themes list, forcing the presentation layer to understand preference semantics; resolving on the service side gives every consumer the same resolved snapshot.

**Settings importing and enumerating the sections.** Adding a page would require modifying the shell plugin, breaking the composition model where each feature occupies a slot from its own plugin.

**A per-feature `ui-settings-*` satellite package for each section.** It divorces the settings surface from the feature itself: changing Theme behavior touches two packages, the package count grows linearly with settings items, and the satellite packages depending back on the locale/theme services form an intermediate layer that exists purely for the package split. Under feature-owner self-registration that layer does not exist: preference rows ship with their feature packages, and `ui-settings-general` takes in only the ownerless copy (the chrome and the General skeletons), carrying no feature's settings surface.

**Injecting the Locale/Theme snapshots into React directly.** Inject results are cached by entry identity, so volatile values go stale; hand-rolling a React hook per service also bypasses the slot store's unified binding.

## Acceptance criteria

- The Settings shell depends only on the slot ledger, never on any feature implementation; General's item list likewise depends only on the ledger.
- Adding a settings item = the feature package registering it itself (a section or a general item), with zero shell changes.
- Locale and Theme writes go only through the setters; ongoing synchronization goes only through the change events.
- Each feature row's store initializes from the getter and is thereafter updated by its own change event with local re-renders.
- Layout applies the theme snapshot on its own and the theme service never accesses the DOM; no system branch appears in the presenter.
- 中文/English and Light/Dark/System switch and are restored after a refresh; with the preference on system, a system color-scheme change takes effect immediately.
- Models has only a navigation item and an empty content area; the Permission and Tool Call skeletons perform no writes.
- The overlay closes via the close button, a mask click, and ESC.

## Risks

The apply order of slot declarations and contributions is not fixed, so every section/item registrant must use `ctx.slots.inject()` rather than a service or local-disposer presence signal. Service events may fire before a row's first render, so both a feature row store's init and the inject attach must align to the current snapshot from the getter. The duplicated merge copies of `settings.general.item` (locale, ui-theme) must stay verbatim-identical to the ui-settings canonical home — any drift means changing all three together. Layout must clean up the global attributes it set on unmount, and ThemeRuntime must remove its matchMedia listener on dispose, so nothing lingers after HMR.
