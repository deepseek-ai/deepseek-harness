# Agent Note: Two-stage Composer and DraftEditor isolation

Status: proposed

English | [中文](2026-09-14-composer-model-and-draft-editor.zh.md)

## Problem

One Client needs to edit the same Session's draft and pending attachments in multiple views. A Lexical editor binds only one DOM root; multiple presentation locations need multiple editor instances, but must not own unrelated drafts or upload tasks, or make the Session Controller understand carets, composition, or DOM state.

The current [SessionInputShell](../../../../packages/client/ui-conversation/src/client/input/facade.ts) combines Lexical operations, draft projection, the submission state machine, and failure recovery. [InputBar](../../../../packages/client/ui-conversation/src/client/skeleton/InputBar.tsx) combines editor presentation, DOM bindings, attachment intake, and submission controls. Implementing multiple instances directly in these files would mix code extraction with behavior changes.

[ConversationController](../../../../packages/client/ui-conversation/src/client/service.ts) already owns attachment entities and upload tasks centrally; the shell retains only ordered attachment IDs. Selecting a skill inserts ordinary `/name` text whose highlighting derives from a lexicon; atomic file and Session references use chips carrying source identity. A shared draft must not lose these references by synchronizing text alone, and does not require copying attachment entities.

This proposal details editor isolation for [#3951](https://github.com/deepseek-ai/deepseek-harness/pull/3951), following [Client Session and UI ownership](../../implemented/architecture/2026-08-20-client-session-conversation-ownership.md). The Session activity view, residency states, and eviction policy are designed independently; [#4138](https://github.com/deepseek-ai/deepseek-harness/pull/4138) is only a Host lifecycle reference. This proposal implements none of those features and does not repeat the Conversation component decomposition in #3984.

## Proposal

Use two independent PRs. Stage one concentrates existing editor implementation into explicit locations for behavior changes; stage two changes behavior only. `DraftEditor` names the draft-editing area, while Composer names the complete writing area including attachments and submission controls. Keep `input/`, `skeleton/`, `InputBar`, `InputHub`, and `SessionInputShell`; directory moves and renames are not refactoring deliverables.

### Stage one: five mechanical responsibility extractions

The ui-conversation paths below are relative to `packages/client/ui-conversation/src/client/`. Every new file must contain logic already executed today, not placeholder interfaces or future features.

| Original location | Extraction destination | Location for later behavior changes |
|---|---|---|
| Lexical creation, registration, projection, node operations, and cleanup in `input/facade.ts` | `input/editor/runtime.ts` | One editor's implementation and its creation, binding, and disposal |
| Text-area JSX in `skeleton/InputBar.tsx` | `input/editor/DraftEditor.tsx` | One editor's presentation, excluding the attachment rail and submission orchestration |
| Focus, selection reveal, wheel, keymap, and picker binding functions in `InputBar.tsx` | `input/editor/view-binding.ts` | DOM interaction and editor bindings for one mounted view |
| Range, reference, and keyboard interface types in `contract/input.ts` | `contract/draft-editor.ts` | Editor-facing data and operation types; submission and shared state stay in the original file |
| Document drop effect implementation in `ui-attachment/src/client/ComposerAttachments.tsx` | `ui-attachment/src/client/drop-events.ts` | Document drag-and-drop registration, routing, and cleanup |

The existing shell creates and delegates to the internal object in `runtime.ts`. That object retains the original editor, NodeKey map, projection, and Lexical registrations; it neither copies those states nor independently decides whether editing or submission is permitted. The shell retains SubmitMachine, draft revision, attachment IDs, notices, attempts, serialization, and success/failure recovery decisions.

Methods combining guards and node operations retain their guards at the original location. For example, beginCommand keeps its span/phase checks, node replacement, and machine dispatch in the same order; failure recovery preserves batch ordering, revision guards, restoration flags, and history cleanup timing. Editor updates still call the shell synchronously at the original publication point, without another Promise, effect, or notification turn.

`DraftEditor.tsx` extracts presentation without adding a DOM wrapper. All existing React hooks, refs, dependency arrays, and relative effect order remain in InputBar; effects delegate to ordinary functions at their original call sites. CSS files, class keys, React keys, placeholder order, and decorator order remain unchanged. The new component does not take over editor creation or hold another draft.

`contract/draft-editor.ts` receives `TokenSpan`, `ReferenceInsert`, `ArbitrateKey`, `ArbitrateOutcome`, `ComposerKeyboard`, `EditSelection`, and `Occurrence`. Names and members remain unchanged, consumers import from the actual declaration owner, and existing public exports retain their names and visibility. `ComposerKeyboard` temporarily still depends on shared `InputState`; this is not an independent controlled-editor protocol.

#### Stage-one invariants

- InputHub still creates one shell and one editor per Session, with unchanged creation, reuse, and disposal timing and counts.
- Lexical remains the draft authority; Undo/Redo, NodeKey identity, span checks, and revision rules remain unchanged, without a second document or store.
- `useInput`, `inputActions`, Slots, events, inject declarations, and public APIs retain their names, payloads, and behavior; Host protocols and persistence formats do not change.
- Attachment selection, upload timing, image previews, submission batches, success clearing, failure restoration, and notice rules remain unchanged.
- Each original component still registers document drop listeners in the same effect; the single picker, duplicate drop, and single editor/root limitations remain.
- Tests change only type imports that actually need updating; test filenames, assertions, recorded Sessions, and expected outputs remain unchanged, without snapshot refreshes.
- No existing file moves, existing private-name changes, CSS changes, new packages, dependencies, renderer scopes, or general state framework.

#### Isolation actually achieved in stage one

| Subject | Result |
|---|---|
| Editor implementation | Node and projection operations belong to runtime, presentation to DraftEditor, and DOM bindings to view-binding |
| Submission and attachment orchestration | Still owned by the original shell and ConversationController, not DraftEditor |
| State across different Sessions | Remains isolated under existing rules |
| Shared state within one Session | Still reuses the original shell, without duplicate attachments or uploads |
| Independent editors within one Session | Not implemented; views still share one Lexical editor |
| Independent selection, IME, Undo, and menu origins | Not implemented; separating code does not change runtime ownership |
| Multi-view picker, focus, and document drop routing | Not implemented; binding code has a separate location for modification |

### Stage two: behavior changes only

Stage two implements a shared draft and multiple editors directly in the locations above. It must not move existing files or directories, perform pure renames or helper/class/component extractions, reorder existing tests, or clean up formatting or comments. New types, implementations, and tests required by new behavior may be added, but copying old code into a new file and deleting its original does not evade this restriction.

If behavior implementation still needs structural preparation, complete stage one first: amend its PR before merge, or add a separate mechanical prerequisite PR after merge. The behavior PR uses that mechanical result as its base and cannot include the preparation.

#### Final state ownership

The shared Composer model evolves the responsibilities of the existing SessionInputShell without requiring another rename. The Session Controller continues to own only Session business state and does not import DraftEditor, Lexical, or the shared draft document.

| State | Final owner | Multi-view requirement |
|---|---|---|
| Draft text, semantic references, and content revision | Session-associated shared Composer model | Publish edits from either view to every view through one reactive source |
| Ordered attachment IDs, claims, submission attempts, and failure recovery | Shared Composer model | Settle each submission once; operations in either view affect the same pending input |
| File, Blob URL, upload tasks, progress, and receipts | Existing attachment owner | Do not copy per view; unmounting one view does not cancel resources used by another |
| Lexical, DOM, NodeKey mappings, selection, and IME preedit | Each DraftEditor instance | Two independent editors/roots; unmounting one does not detach the other |
| Menu anchor, file dialog, and focus | Initiating view | Route by operation origin, not a single Session picker |
| Session history, running, and queue | Session Controller | Keep reading existing sources instead of copying them into the draft model |

The renderer still binds React hooks from bare observables, and business components read and write through existing standard props. The shared model accepts neither DOM, Lexical NodeKeys, nor composition intermediate state; DraftEditor receives neither Session/Context nor upload services, only draft data, presentation data, and editing/intent callbacks.

#### Shared content and synchronization requirements

Draft content must represent ordinary text, newlines, and atomic references with complete `ReferenceInsert` information independently of Lexical. Shared reference identity must not depend on one editor's NodeKey; each instance privately maps it to its own nodes. Skills remain ordinary `/name` text, with both views deriving highlights from the same text and lexicon, without an extra selected-skill list or changes to Host recognition.

Draft text is small, so synchronization may use complete semantic documents without requiring a collaborative-editing algorithm. The shared model accepts edits, assigns revisions, and publishes; editors distinguish local changes from external rendering to avoid feedback loops. Callbacks from stale revisions, prior model lifetimes, or unmounted views must not overwrite current content. Submission freezing, success clearing, failure restoration, and attachment changes must reach all views through the same shared source.

IME preedit belongs to the local instance, and updates from another view must not directly disrupt text under composition. Stage two must define and verify how another view's edits, submission clearing, and model release interact with composition. Undo/Redo must also operate on one logical draft, rather than letting two Lexical histories restore stale whole documents over each other; synchronization and history implementation are outside the mechanical stage.

Programmatic insertion, menu selection, file selection, and focus restoration need the initiating view's temporary identity. Closing that view must not redirect late UI actions into another view of the same Session. Document drop must select one explicit target and process the drop exactly once; origin routing and deduplication are stage-two behavior.

Existing text-draft restoration after refresh must remain, without implicitly promising persistence for structured references, File objects, or cross-browser collaboration. The Session activity view and LRU/timeout policy remain independent of this editing protocol.

## Alternatives considered

**Only rename input or relocate it to composer.** This does not separate Lexical operations, view bindings, and submission decisions; behavior implementation would still need to extract old code from large files, so it is not a stage-one deliverable.

**Bind one Lexical editor to two DOM roots.** This conflicts with Lexical's single-root model; copying React presentation does not create two independently interactive editors.

**Give each Composer an independent draft and attachments.** This fails the same-Session shared-editing requirement and introduces conflicting attachment and submission ownership.

**Implement a shared DraftDocument, Undo, or drop deduplication in the mechanical stage.** This changes authority, lifecycle, or event-processing counts and cannot be reviewed as behavior-preserving preparation.

## Acceptance criteria

Stage one completes the five extractions and required imports, JSDoc, and README updates; review compares original method bodies, branches, callback order, hooks, DOM, and cleanup. Existing editing, reference, claim, attachment, submission, failure-restoration, and unmount tests continue to pass; focused browser regressions run against built artifacts with unchanged expected output. Type and documentation checks cover relocated declarations and bilingual pairs. New dual-instance functionality is not a stage-one acceptance condition.

Stage two uses two genuinely mounted Composers for one Session to verify bidirectional text and chip synchronization, skill highlights, shared attachments and progress, submission clearing/failure restoration, IME/Undo, origin routing, and continued operation after either view unmounts. Its diff contains behavior implementation and corresponding tests only, without mechanical cleanup.

## Risks

Even stateless JSX extraction can alter ref or effect timing; therefore hooks and refs retain their host, and DOM gains no wrapper. Lexical extraction can alter nested updates, projection caching, or history cleanup order; therefore retain original operation bodies and compare execution order instead of rewriting algorithms.

Stage one still cannot mount two editors for one Session and retains the existing picker/drop limitations. Confusing directory isolation with state isolation could cause roots to detach each other, duplicate attachment intake, or misroute focus; stage-two dual-instance behavior tests must close these gaps.
