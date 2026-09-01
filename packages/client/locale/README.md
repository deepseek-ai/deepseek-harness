---
description: "Localization for the web GUI: the zh/en preference, browser-derived fallback, typed namespace dictionaries, and the framework translation seat, for users and plugin authors."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-locale

English | [中文](README.zh.md)

## Summary

`dsh-client-locale` localizes the web GUI: users choose from the registered languages in Settings → General, and the UI copy switches immediately. The package ships `zh` and `en`, while external client plugins can add languages and their namespace dictionaries. On a loopback page, the choice persists as `locale.preference` in `$DSH_HOME/settings.yaml`; a non-loopback page keeps its selection process-local even though Connection authenticates every API method. A fresh browser starts provisionally in the first registered language requested by `navigator` until an allowed Host preference arrives and replaces it live. Plugin authors receive full type checking for the built-in dictionary form and translate through the framework `t` seat; copy rendered through slots follows language switches without a reload.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use it wherever the web GUI needs a language switch or translated copy: the shipped settings row covers users, and plugin authors register their own dictionaries. Nothing needs configuration to mount — the package activates with the client tree.

### Choosing a language

Open Settings → General and select a registered language. The active locale is applied immediately: the UI copy switches, `<html lang>` points at the external id or built-in document tag, and the choice is written to the durable settings section. A browser without an explicit Host preference selects the first registered language that matches `navigator` by full tag and then primary subtag, falling back to English. A stored external locale waits for its definition to register instead of becoming active while unavailable.

### Registering a dictionary

Call `ctx.locale.register(ns, { zh, en })` with a namespace merged into `LocaleNamespaceMap`; the compiler checks every key against the namespace's typed key union and requires both shipped locales. Consumers translate through `ctx.locale.bind(ns)` or the framework-injected `t` seat. A dictionary registered after the UI is already mounted is picked up without a remount.

### Registering a language pack

An external client plugin registers the language definition and each translated namespace as owned effects; definitions and dictionaries may register in either order:

```js
export const inject = ['locale']

export function apply(ctx) {
  ctx.effect(
    () => ctx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }),
    'my-locale: language',
  )
  ctx.effect(
    () => ctx.locale.register('common', 'ja', {
      cancel: 'キャンセル',
      close: '閉じる',
    }),
    'my-locale: common dictionary',
  )
}
```

An external id is a non-empty ASCII BCP 47-style tag. Its fallback must already be registered, and the chain must terminate at `en`; unknown targets, duplicate ids, and cycles fail at registration. Lookup walks the fallback chain in the requested namespace, repeats it in `common`, then displays the key. Unloading a definition removes it from the selector and returns an active selection to the available browser/default locale.

### What the Host half does

The Host persists the preference through the settings service on loopback pages. The Client deliberately withholds that settings scope on non-loopback pages, so their locale selection remains process-local even though Connection authenticates every API method.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the locale service is built; observable behavior is covered in [Use this package](#use-this-package).

### Design concept

One `LocaleRuntime` owns the preference and the dictionary registry, and is itself the slot system's `LocaleFace`: `getSnapshot`/`subscribe` back the framework-injected `t` seat through `ctx.slots.installLocale`. The immutable snapshot carries the active locale, the selectable locales, and a monotonic revision; dictionary registration and locale switches both advance the revision, but only a switch emits the `locale/change` event. Product-authored Client UI text must enter through these typed dictionaries or an already-localized primitive prop; `verify-client-ui-i18n` enforces that source ownership ([decision](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md)).

### Preference resolution

The provisional locale comes from the browser (`navigator.languages` matched by full tag and then primary subtag, English as the fallback), standing in until the allowed Host-backed settings scope delivers its stored preference. The Host read runs after plugin activation so an unavailable or withheld settings scope cannot block the page, and the result replaces the provisional value live. A stored external locale waits for its definition to register. `setLocale` is the only write entry; it persists even when the id already matches the active locale, because the active value may be provisional and must survive a different browser sharing the same home.

### Dictionary lookup

The typed object form requires complete dictionaries for both built-in locales. The per-locale form lets language packs register each namespace independently. For each key, lookup walks the active language's declared fallback chain in the requested namespace, repeats that chain in `common`, then displays the key itself. Bound translate functions retain stable identity per namespace so they can ride inject surfaces without breaking memoization.

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | `LocaleRuntime`, dictionary registry, Language row registration, `locale/change` event |
| [`src/index.ts`](src/index.ts) | Node half: registers the `locale` settings namespace |
| [`src/locale-settings.ts`](src/locale-settings.ts) | The durable schema for `locale.preference` |
| [`src/locales/`](src/locales/) | The shipped `zh`/`en` dictionaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the locale contract is not enough: the slot face it implements, the settings surface it rides, and the persistence decision behind the preference.

- [Client slot system](../ui-slots/README.md) — the slot model and the `LocaleFace` seat this package implements.
- [Host-backed preferences decision](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.md) — why the preference persists in Host settings instead of the browser.
- [Settings group map](../../settings/README.md) — the settings service that stores the preference.
- [Client group map](../README.md) — the browser half this package belongs to.

-----

<a id="model-experience"></a>
## Model Experience

None, as the locale service is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where localization is incomplete or frozen at registration time. They are current package constraints, not a task backlog.

- **Registry-held text reads its translation once** — copy captured at registration time outside the slot render path (e.g. the `/model` command description in the command registry) keeps the language it was registered under until re-registration; slot-rendered copy follows switches live.
- **Language packs own language-specific behavior** — the registry supplies selection, persistence, browser matching, key fallback, and `<html lang>`; it does not add plural rules or bidirectional layout.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The locale catalog and dictionaries have no independent runtime source to compare against; registration disposal, preference resolution, and fallback lookup are asserted by behavior specs.
