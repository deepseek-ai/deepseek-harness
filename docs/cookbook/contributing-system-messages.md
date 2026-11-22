# Cookbook: contributing system messages

English | [中文](contributing-system-messages.zh.md)

## Summary

Register named instructions with `ctx.systemPrompt.section()` so accepted agent steps introduce them, send changed text, and retire them after their owner unloads. This tutorial assumes a Cordis plugin mounted in a `dsh` profile that provides `systemPrompt`; use the [package checklist](adding-a-package.md) to create that plugin.

## Table of Contents

- [1. Register instructions](#1-register-instructions)
- [2. Update the text](#2-update-the-text)
- [3. End the registration](#3-end-the-registration)
- [4. Choose scope and message kind](#4-choose-scope-and-message-kind)
- [5. Verify admission](#5-verify-admission)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

<a id="1-register-instructions"></a>

## 1. Register instructions

Declare the service dependency and register through your plugin's `ctx`. Cordis owns the returned disposer and cleans up the registration when the plugin unloads.

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-system-prompt'

export const name = 'example-response-style'
export const inject = ['systemPrompt']

export function apply(ctx: Context) {
  ctx.systemPrompt.section({
    name: 'example:response-style',
    order: 100,
    text: 'Use concise sentences and include relevant file paths.',
    interpolate: false,
    retirement: 'The response-style instructions no longer apply.',
  })
}
```

Use a stable, namespaced `name`: it identifies the same instructions across updates and reloads. The nearest scope shadows enclosing registrations with the same name; within one scope, the latest live registration wins. `order` must be finite; sections sort by order, then name. These examples use local order values; first-party contributions use the owning slot from `getSectionOrder()`. Look up the available names and values in `SECTION_ORDERS`, alongside `SystemPrompt.getSectionOrder()`, in [the system-prompt source](../../packages/core/system-prompt/src/index.ts).

<a id="2-update-the-text"></a>

## 2. Update the text

For changing instructions, keep one registration and let its synchronous `text` callback read current state. Call this helper from your plugin's `apply(ctx)`, then call the returned `update()` from the state-change handler you own.

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-system-prompt'

export function registerInstructions(ctx: Context, initialText: string) {
  let currentText = initialText
  const dispose = ctx.systemPrompt.section({
    name: 'example:workspace-policy',
    order: 200,
    text: () => currentText,
    interpolate: false,
    replacement: 'The workspace policy has changed.',
    retirement: 'The workspace policy no longer applies.',
  })
  return {
    update(text: string) { currentText = text },
    dispose,
  }
}
```

The effective registration’s callback runs on each `assemble()` call, including inspections and proposed steps that may not be accepted. Hidden registrations’ callbacks do not run. Keep it free of side effects; it does not run only when the text changes. Assembly with a Session captures the rendered text; the loop compares it with the Session’s committed system records and commits the resulting message deltas before the accepted step’s first request. Retries reuse that assembly, and a compaction during the step rebuilds the system head from the same captured text. `update()` does not itself send a message or start a model request. An already assembled step retains its captured text.

Omit `replacement` to get the default notice naming the changed section, or set it to `''` to omit the prefix. The notice applies only to an update of previously admitted instructions, not their introduction. Calling `section()` again in the same scope overrides the previous registration until the new one is disposed; reading mutable state in `text()` avoids adding an override.

**Set `interpolate: false` explicitly on every new section**, as in both examples, to avoid unexpected interpolation. The API keeps its `true` default for compatibility, so omitting the option can substitute `{{name}}` or fail on an unknown variable, even in text returned by a callback. Compute dynamic text in the callback using ordinary JavaScript expressions or template literals instead. System sections are trimmed before direct text comparison, so changing only leading or trailing whitespace sends no update.

For large, mutable system prompts, split independently changing instructions into multiple sections. For example, keep stable response rules separate from frequently updated workspace instructions. Give each part a stable name, its own order and text provider, and an explicit retirement notice. Updates resend the whole changed section; splitting lets you update or retire one part without resending unchanged parts.

To make a still-registered section empty, return `''`. A new empty section contributes nothing; an existing nonempty section becoming empty uses its replacement notice, or the default retraction when no replacement is supplied. Whitespace-only strings behave the same way, so `"\n"` becoming `"\n\n"` sends no additional update.

<a id="3-end-the-registration"></a>

## 3. End the registration

Call the returned `dispose()` when the instructions stop applying before plugin unload. Otherwise let Cordis teardown do it. Provide an explicit `retirement` notice for every section so the model knows which instructions no longer apply. The API permits omission, but a descriptive notice is encouraged. It is literal text and must remain nonempty after trimming; cleanup never calls the disposed text provider again.

Disposal removes that exact registration. If another visible registration has the same name, the next assembly uses its text and replacement notice instead of retiring the source. Retirement requires every registration in the visible scope chain to be disposed; only Sessions that observed registrations and previously committed the name receive it. The last disposed observed registration supplies the retirement notice. Registering and disposing before admission produces no retirement message for an uninformed Session. Disposing and re-registering the same name before the next admission sends nothing when the rendered text is unchanged, or one replacement update when it differs.

For several registrations sharing one lifetime, yield their disposers from a Cordis generator effect. The [tools executor registration](../../packages/core/tools/src/index.ts) uses this pattern. If a later registration throws, Cordis cleans up the earlier registrations; their ordinary retirement behavior still applies.

<a id="4-choose-scope-and-message-kind"></a>

## 4. Choose scope and message kind

Register through an agent's `ctx` for instructions specific to that agent. Reuse a parent source's name to override it; use distinct names for instructions that need independent retirement. For persona overrides, register `PERSONA_PREFIX_SECTION` or `PERSONA_SUFFIX_SECTION` with the corresponding `getSectionOrder()` slot, or mount the [persona plugin](../../packages/preset/persona/README.md) to register both. Prefix-only overrides inherit the suffix. Keep changing operational facts, such as working directories, in `ctx.systemPrompt.context()`; they become user-role context snapshots and have a separate refresh path.

`complete: true` is strongly discouraged for plugins. It is retained only to let the [minimal preset](../../packages/bundle/web-app/presets/minimal.patch.yml) suppress normal system messages, an exception applicable in almost no plugin scenario. Contribute ordinary sections instead; suppressing the entire prompt also removes other plugins' instructions.

<a id="5-verify-admission"></a>

## 5. Verify admission

Exercise the contribution in an agent Session and inspect its logged `system/message` events. Registration and assembly alone do not commit messages; the loop appends the prepared deltas once on the first attempt. The [admission tests](../../packages/core/system-prompt/tests/admission.spec.ts) show a small harness for package tests.

1. Admit initial text, then admit unchanged text: the second admission adds no system update.
2. Change the callback's state: the next accepted assembly adds only that section's text and replacement notice.
3. Change only surrounding whitespace: no update is added.
4. Dispose an override: inherited instructions return through an ordinary replacement. Dispose all visible registrations: an informed Session receives one retirement notice; a fresh Session receives none.
5. Dispose and restore identical text between admissions: no retirement or replacement is added.

Run the existing focused behavior tests while developing a contribution:

```sh
pnpm exec vitest run packages/core/system-prompt/tests
```

Read all surviving system messages when inspecting a transcript; later messages contain updates, not the complete prompt. Compaction can consolidate them. Runtime definitions and uncommitted disposal state are process-local. Replayed or inherited text alone cannot recover retirement for a source never observed by the current Session; see the [known limitations](../../packages/core/system-prompt/README.md#known-limitations-and-deferred-work).

<a id="further-exploration"></a>

## Further Exploration

- [System-prompt API reference](../subsystems/system-prompt.md) — types and service methods.
- [Section admission rationale](../../.agents/notes/implemented/architecture/2026-10-21-section-based-system-updates.md) — registration, scoped overrides, and retirement.
- [Deferred compaction rebuilding](../../.agents/notes/implemented/architecture/2026-11-09-deferred-system-compaction.md) — captured sections and the rebuilt instructions after compaction.

<a id="dev-note"></a>

## Dev Note

None.
