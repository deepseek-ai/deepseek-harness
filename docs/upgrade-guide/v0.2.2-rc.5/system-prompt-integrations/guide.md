---
kind: upgrade-guide
description: "System-message consumers must accumulate section updates and recognize source-specific notices."
---

# System sections and custom integrations

English | [中文](guide.zh.md)

## Change

Later `system/message` events contain section updates rather than complete prompts. Consumers must preserve all surviving system messages. Accepted assemblies compare source text and order with logged state; disposal produces retirement only for a previously committed source with no remaining live registration. Rejected assemblies commit nothing. Legacy messages without `source.sections` remain readable; the next model attempt replaces the initial system node with current sections and clears later system messages, as after compaction.

`section()` accepts repeated names: the nearest visible scope wins, then the latest live registration within that scope. Disposing an override restores the next definition. Plan mode keeps conditional instructions and appends active/inactive status updates.

Sections are trimmed after interpolation and stored as separate text blocks; system service inserts no whitespace separators. Each active record has `contentIndex` pointing to its actual text, including an empty text update; retired records omit it. Optional `noticeIndex` arrays identify replacement and retirement blocks belonging to a source. Whole-prompt supersession notices remain unattributed. Notices are trimmed too; retirement notices must be nonempty.

Compaction summarizes the selected conversation under its logged instructions. Before the next model attempt, ordinary system-message replacements first clear later system updates, including those outside the selected range, then install current sources at the initial system node. Idle inspection retains the old instructions until that attempt. No additional message projection or Session event type is required.

## Migration

1. Keep section names stable and use distinct names for independent instructions. Reuse a name only for an override. Keep registrations alive while their instructions apply; dispose them to withdraw the source. Optionally provide literal `retirement` text and a `replacement` notice; a blank replacement suppresses that notice. Dispose and re-register between admissions without changing the effective text to avoid redundant updates.
2. Update custom transcript, SDK, adapter, and viewer consumers to accumulate sections and distinguish actual text from notices using the indexes above. Preserve meaningful whitespace inside sections; do not use whitespace-only sections as separators. Adapters choose separators when formatting requests. Existing logged text is unchanged; previously untrimmed text may receive one normalized update.
3. Custom compositions must load `session-projection` before using `system-prompt`. Instead of consuming `systemMessages`, custom loops call `PromptAssembly.systemUpdates(retry)` before each model attempt, including overflow retries, and append every returned `{ message, intent }` as a `system/message` event, in order and without yielding. Pass `false` on the first attempt and `true` on later attempts; later attempts receive only the rebuild that compaction requires. Retries reuse their assembly. See [loop admission](../../../../packages/core/agent-loop/README.md#understand-the-implementation).
4. Verify that unchanged sections send nothing, changed sections send updates, and disposal sends one retirement after the last visible registration leaves. Remove a persona override and confirm that the parent persona takes effect.
