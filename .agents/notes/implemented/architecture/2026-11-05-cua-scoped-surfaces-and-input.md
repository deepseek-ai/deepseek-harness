# Agent Note: CUA scoped surfaces and separated input capabilities

Status: implemented

English | [中文](2026-11-05-cua-scoped-surfaces-and-input.zh.md)

## Problem

Application and window objects share accessibility operations, but only an explicit window can capture or deliver pointer input. Duplicating shared methods on both factories creates two implementations to keep aligned. Moving application-only capability checks into the shared base makes window behavior depend on an application-level decision. Keyboard input has the same problem at a smaller scale: a chord string combines a key and its modifiers, and a complete-keystroke method cannot express a modifier held across calls or a standalone key-up.

## Decision

`CuaSurface` declares operations shared by application and window objects; `CuaApp` and `CuaWindow` extend it with their own operations. One base factory builds the surface, and the derived factories inject scope parameters plus `requireAccessibility` and `requireKeyboard` checks. The shared base never branches on a capability that exists only for applications.

Provider startup capabilities are static. Platform, supported methods, application-level accessibility, keyboard scopes, browser support, and coordinate space are fixed when the provider is installed. The native `getCapabilities` RPC reports runtime permissions and session lock only; `installCua` merges the two layers for the model-visible result. The neutral RPC is a common operation representation, not a capability inventory; provider guidance names the actions its platform supports.

Keyboard input keeps keys and modifiers separate: `pressKey(key, modifiers?)` presses and releases one key while holding the listed modifiers, and its keyboard modifier list is a plain string array defined by the provider. `sendKeyEvent(key, direction)` sends exactly one key-down or key-up without an implicit counterpart. A caller can therefore hold a modifier or split a gesture; neither method packs a chord string, and the shared schema does not enumerate platform key names.

Within one API instance, the object facade keeps one current accessibility snapshot per application handle, shared by every application and window object for that handle, including repeated selections of the same application. `getWindow` reads its initial tree silently; `getApp` does the same when the provider reports application-level accessibility. A later `getAccessibilityTree` read invalidates the previous snapshot before dispatch. The facade automatically attaches the latest snapshot ID to element operations; callers use element IDs from the latest tree and do not assume an older ID still identifies the same control. Element IDs are opaque provider strings. Only an explicit `CuaWindow` captures screenshots or sends pointer input. The native helper retains its own application and optional-window snapshots behind that facade; the native layer and the facade snapshot remain separate. The external runtime continues to own variable persistence and completion serialization; the facade adds no evaluator. The [native object decision](2026-09-17-experimental-cua-object-api.md) owns evaluator independence, and the [shared helper decision](2026-10-09-cua-shared-native-helper.md) owns connection lifetime.

## Alternatives considered

**Duplicate application and window methods** would give each factory its own implementation of the same accessibility operations. Every shared change would then need matching edits, and the two surfaces could accept different arguments or results. One `CuaSurface` implementation keeps that behavior single.

**An application-specific branch in the shared base** would let window objects inherit decisions and capability checks that apply only to applications. Scope factories that inject their own requirements keep the shared operations independent of which scope uses them.

**A packed chord string** requires parsing key names, separators, and plus escaping together, and it pushes platform alias normalization into the shared layer. Keystroke and direction are separate semantics: `pressKey` describes one complete keystroke, while `sendKeyEvent` describes one explicit direction. Separate key and modifier values keep those semantics without a parser.

**Platform keyboard key enumerations in the shared schema** would couple the portable operation schema to one provider's key names and require a schema change for each platform. Provider-defined strings let the provider interpret its own names while the shared schema stays neutral.

**Static capabilities reported by native** would duplicate provider configuration in the native helper and make the helper responsible for knowledge that is fixed before it starts. The helper reports runtime state; the provider owns its startup capabilities.

## Consequences

Element IDs belong to the application's current accessibility snapshot. Reading one window replaces the facade’s current snapshot for that application, so callers observe again and confirm the IDs they use. The new read does not guarantee that an old string is rejected or that an ID changes; callers must not assume an older ID still identifies the same control. Pointer input and screenshots require an explicit window object; callers enumerate windows first.

Keyboard behavior follows the provider's supported scopes. A caller that uses `sendKeyEvent` owns the down/up pairing, because the API never sends the opposite event. Keyboard modifier names are provider-defined, so the same string may have different support across providers.

Provider guidance owns the list of supported actions. Adding a method to the shared schema does not claim that every provider implements it, and the merged `getCapabilities` result remains the runtime source for permissions and session lock.
