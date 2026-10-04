# Agent Note: Initial draft content and structured reference restoration

Status: implemented

English | [中文](2026-09-30-structured-draft-initialization.zh.md)

## Problem

New-task entry points need to place unsent content in the composer. A draft contains not only text but also file, folder, and Session references the user has selected. Saving only their text projection loses the chips' source, target, and presentation fields when the input object is disposed. Filling the composer after mounting also cannot guarantee that the first input-model read contains the complete document.

## Decision

Keep the existing `SessionInputShell`, `DraftEditorRuntime`, Conversation store, and Session reference lifetime. Plain text and structured drafts enter through the input model. Initial import finishes before `InputHub.shellFor()` returns, without React effects restoring text. Existing input objects are not restored again. React mounts the same editor and binds the existing persistence callback.

The second parameter of `startSession(workspaceId?, options?)` contains `prompt` and `clearPreviousDraft`. `prompt` accepts only a string; structured drafts remain internal to restoration and Workspace transfer. Omitting options preserves the existing flow. Without clearing, existing content is preserved and only an empty draft adopts the prompt. Explicit clearing replaces the target Session's text document, without deleting attachments or changing other Sessions. Prefilling does not send, execute commands, or change `blank`.

### Data model

`DraftSnapshot` contains `text` and `references`. Each reference retains `offset`, `length`, `source`, `ref`, `label`, `appearance`, `clipboardText`, and its existing invalid flag. Positions use JavaScript string coordinates. Reference spans must be ordered, non-overlapping, and equal the corresponding `clipboardText`. Snapshots exclude Lexical NodeKeys, DOM, runtime occurrenceIds, functions, and temporary highlights.

A string represents input without structured references; an ambiguous `@` query never selects a file automatically. The public `SessionInput.setDraft` and `InputActions.setDraft` methods accept only text. Internal structured restoration reuses the editor's reference restoration without listing directories or reading files. Plain text and file, folder, and Session chips all pass through the registered editor transforms and projection.

The existing `dsh.conversation.<sessionId>` key remains. Readers accept both legacy strings and structured `draft` values; new writes store structured values. The original Conversation store still writes the complete record, without a second writer for that key. Reference changes must reach persistence even when the visible text does not change.

### Classes and methods

| Location | Change and responsibility |
| --- | --- |
| `UiWorkspace` / `UiWorkspaceService.startSession` | The second parameter is `StartSessionOptions`; the existing `beforeOpen` preparation point passes initialization to the exact target binding. Creation, reuse, and navigation cancellation remain unchanged |
| `SessionInputResolver` / `InputHub.requestDraftInitialization` | Accept the binding and options and delegate to that binding's input object, without looking up a global current Session |
| `InputHub.shellFor` | After registering a new object and its cleanup, read the Session's saved draft, import it through the input model, and return. Reused objects are not restored again |
| `readConversationDraft(sessionId)` in `stores.ts` / `parseStoredDraft` in `draft.ts` | Read the original storage key, accept legacy strings, and check structured reference fields and positions without creating a store or another writer |
| `SessionInputShell.setDraft` | The concrete internal method accepts a string or `DraftSnapshot` and imports one document through the editor; public input methods accept only text. Neither path simulates keyboard events or submits |
| `SessionInputShell.requestDraftInitialization` | Apply clear, preserve, and prefill rules to the restored model; refuse changes during submission without clearing first |
| `SessionInputShell.draftSnapshot` / `persistCurrentDraft()` | Cache snapshots without runtime IDs by content revision; `InputActions.persistDraft()` delegates explicit saving, while `bindDraftPersistence(write)` only binds the callback |
| `DraftEditorRuntime.restoreDraft` | Rebuild ReferenceChipNodes from semantic reference fields; existing failed-send restoration uses the same implementation |
| `SessionInputShell.refreshLexiconSubscription()` / `DraftEditorRuntime.refreshLexiconSubscription()` | `InputHub` owns the Session-scope `inject` callback that connects the lexicon after caching the shell, reconnects when the service arrives or is replaced, and unsubscribes on disposal. Both connection and catalog updates rescan the current editor without writing old text back; `setDraft` does not establish the subscription |
| `ConversationStoreState` / `createConversationStore` | Support structured input and legacy strings in draft storage, keeping View state and the original key |
| `DefaultConversationViews` | Remove restoration and prefill effects, retaining persistence binding and unbinding. Initial saving reads the owner's current snapshot, never text captured during render |
| The existing `selectWorkspace` callback in `apply.ts` | Keep the existing cross-Workspace draft-transfer rules, passing `draftSnapshot` instead of plain text so transfer retains references |

There is no new draft service, storage key, general task framework, or Session creation entry point. SlotRenderer, Host Session logs, command execution, and file-discovery RPCs are unchanged. `InputActions` remains the shared input-action entry; components receive no separate content-initialization callback.

The call parameters are `startSession(workspaceId?: WorkspaceId, options?: StartSessionOptions)`, `requestDraftInitialization(binding: SessionBinding, options: DraftInitializationOptions)`, `SessionInputShell.requestDraftInitialization(options)`, and the internal `SessionInputShell.setDraft(input: string | DraftSnapshot)`. `StartSessionOptions` aliases `DraftInitializationOptions`, whose fields are `prompt?: string` and `clearPreviousDraft?: boolean`. A shallow copy captures these values before asynchronous creation, and the result addresses only the retained target binding. Initialization distinguishes applied, preserved, and submission-blocked outcomes. Refusal does not clear first; superseded navigation does not write a draft.

### Data flow

```text
stored draft / startSession options
  → DraftInput
  → SessionInputShell.setDraft
  → DraftEditorRuntime → Lexical → InputState
  → InputHub.shellFor returns
  → React mounts the editor

user edits / input actions
  → editor → projection
  → DraftSnapshot
  → Conversation store
```

### Asynchronous skill matching

Skills remain editable text, not file chips. A pending lexicon never locks the draft. Slash names remain ordinary text until a catalog supplies a matching name; an absent provider, unavailable catalog, or unmatched name produces no skill highlight. The existing subscription rescans the current document on arrival instead of saving and restoring the text present when the request began. This changes neither text nor structured references, does not take the caret, and adds no user Undo step. Commands retain their existing validation and execution path at submission.

## Alternatives considered

**Calling setDraft after mounting.** The first model read and render can still be empty, and later restoration can overwrite a clear. Initialization cannot depend on React-effect ordering.

**Saving only clipboardText and searching references again.** Text does not identify a reference's source and presentation fields. Searching candidates does not restore the user's previous selection; existing structure should be restored directly.

**Waiting for all remote lexicons before allowing input.** File references already have their data, and skill highlighting is not an editing prerequisite. Blocking the draft on those queries adds unnecessary waiting.

**Splitting persistence keys or adding a draft-management service.** The existing input owner and store can perform the work by sharing the input representation and import path.

## Verification

The core model invariants are semantic equivalence after import, export, and JSON round trips without comparing runtime node IDs; a complete document on the first input-object read; and stable draft snapshots across selection or skill-highlight changes. [Document-model cases](../../../../packages/client/ui-conversation/tests/draft-document.client.spec.ts) cover strings, empty drafts, multiline Unicode text, file/folder/Session references, duplicates, invalid flags, placeholder sanitization, and invalid stored spans. [Input-lifecycle cases](../../../../packages/client/ui-conversation/tests/draft-hub.client.spec.ts) cover first reads, reuse, lexicon-service arrival, unloading, reconnection, and retired bindings. Initialization is refused during submission, and lexicon rescans add no Undo step.

[Navigation cases](../../../../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts) check exact retained targets, option copying before asynchronous creation, superseded requests without draft writes, and refusal without changing selection. [Assembly cases](../../../../packages/client/ui-conversation/tests/apply-inject.client.spec.tsx) check that existing Workspace transfer retains structured references. The related regression run passed 708 cases in 44 files; after the shared draft module moved to its owning location, the three affected model and assembly files passed another 66 cases.

The [browser e2e](../../../../apps/web/tests/draft-initialization.e2e.ts) observes the shipped Workspace API through the existing module-loader test instrumentation and calls public `startSession` with text options, without an additional test plugin. Structured fixtures enter through the existing saved-draft restoration path. The cases cover absent, empty, and nonempty prompts; explicit and inherited Workspaces; preservation and clearing; creation and reuse; repeated real-UI Session switching and editing; reload; legacy strings; and Workspace-picker transfer. Both orders of delayed creation responses preserve the newer target and leave the other draft unchanged. A delayed real skill-catalog response rematches current text without replacing chips, selection, or Undo history. Assertions inspect chip fields, file previews, and persisted snapshots. Before sending, Host logs contain neither `user/message` nor `turn/start`.

## Consequences

Missing reference information in legacy strings cannot be reconstructed losslessly, so they restore as plain text without searching and guessing files. Attachment File objects, upload state, cross-browser synchronization, multiple independent editors, and persistent Undo history are outside this change.

This decision shares input ownership with the [editor-isolation proposal](../../proposed/architecture/2026-09-14-composer-model-and-draft-editor.md) without implementing its multi-editor goal. [Reference previews](../../../../packages/client/ui-input-trigger/README.md) and [Session reference lifetimes](2026-09-15-client-session-references.md) continue to govern source routing and generation cleanup independently; neither is superseded.
