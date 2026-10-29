---
kind: upgrade-guide
description: "Client code that builds InputActions or implements SessionInput must provide the required prefill method."
---

# Composer prefill method on input actions

English | [中文](guide.zh.md)

## Change

`InputActions` and `SessionInput` in `@deepseek-ai/dsh-client-ui-conversation/client` now require `prefill(text, options?)`, and the package exports `ComposerPrefillMode` and `ComposerPrefillOptions`. Slot components and Session-scope plugins read prefill from the harness, so their call sites compile unchanged. Code that constructs an `InputActions` value, or implements `SessionInput`, including test doubles passed to client components, no longer satisfies the interfaces until it adds the member. The method returns whether the draft accepted the write; returning `false` is valid for doubles that do not support prefill.

## Migration

1. Add `prefill` to every hand-written `InputActions` or `SessionInput` object. Forward to the harness-provided action, or return `false` when the double does not support writing.
2. Import `ComposerPrefillOptions` or `ComposerPrefillMode` from `@deepseek-ai/dsh-client-ui-conversation/client` when a signature needs them.
3. Rebuild custom Client plugins and their test suites, then run the type check. A passing check confirms the interface is satisfied; call `inputActions.prefill('text')` from a slot component to verify the harness path when the object forwards the operation.
