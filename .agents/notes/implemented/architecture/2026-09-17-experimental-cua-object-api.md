# Agent Note: Native CUA objects independent of evaluator ownership

Status: implemented

English | [中文](2026-09-17-experimental-cua-object-api.zh.md)

## Problem

Computer-use programs need consistent app and window operations. Coupling those operations to a CUA-specific interpreter makes input handling depend on unrelated choices about variable persistence, imports and cancellation.

## Decision

The shared `cua` library owns application/window objects, consent, and logged dispatch. `cua-macos` owns the Swift helper, its build, and its local connection lifecycle. Providers pass a prepared executable and a connection factory to the shared installer, keeping platform code out of object consumers without adding another runtime registry.

The experimental CUA package owns a native-app subset of the Codex-style object interface and selected MIT-licensed macOS behavior adapted from Cua Driver in a Swift helper. A source manifest records the adapted upstream files and local implementation. The helper is locally compiled; the package has no external Cua Driver runtime dependency. The existing [provider registration](2026-09-12-computer-use-provider-registration.md) prevents competing computer-use providers within one composition.

The facade accepts an operation dispatcher. Its tool adapter resolves the current tool binding for each operation, preserving normal authorization, logging and image admission. The execution host owns variable persistence and completion serialization. CUA defines no persistence directive, worker or run_code replacement.

Native process ownership follows the [shared helper decision](2026-10-09-cua-shared-native-helper.md), with isolated Agent connections. App handles bind process identity and kernel start time; replacing the process or helper never revives old handles. AX snapshots are scoped to an app and optional window, so independent window observations remain usable. Coordinate actions select an owned window; the Host maps [screenshot coordinates](2026-10-13-cua-hover-routes-and-coordinates.md) to native window-local points. Keyboard input remains app-scoped because macOS delivers it to the app's current focus.

The operation schema owns shared data declarations. Host-only limits and launch continuations remain separate from model parameters, and generated native field/enum tables preserve independent native admission without hand-maintained copies. Native code continues to own system calls, permissions and cancellation. AX formatting consumes immutable observations; the walker retains sole ownership of indices and AX references.

Clipboard paste is distinct from Unicode key input: Return and Tab key events can trigger actions instead of inserting clipboard content. Pasteboard access runs on the AppKit main actor and retains promised data until a reader requests it. AX command completion alone does not establish that the application has fetched the data. Restoration checks ownership before replacing contents; the caller still verifies the application result. After successful command dispatch, `pasteReadTimeoutMs` bounds waiting for a data request, with a default of 1000 ms. Expiry returns `PASTE_NOT_CONSUMED`, closes the data provider against late delivery, and restores the clipboard only while still owned. The failure reports no read within that interval; it does not prove the application will never process its queued Paste command. A delayed command may read restored clipboard contents, so callers inspect the target and never retry automatically. Foreground-dependent consumption was observed in the installed ChatGPT/Codex application (`com.openai.codex`); other applications need their own validation. Guidance presents this as an example and applies recovery instructions to any `PASTE_NOT_CONSUMED` result.

CUA registers its own Harness tool and returns operation values directly. Screenshot capture requires a resolved image-capable model and the shared attachment service. The tool admits each screenshot once and renders its durable image reference; the object API, combined observation and image sink retain the same `CuaScreenshot` containing encoded `bytes`, `mimeType`, `pixelWidth`, `pixelHeight` and `windowId` from the validated screenshot result. The bridge preserves this metadata without another upload or image emission. Callers use the reported format and dimensions when saving or declaring images.

## Alternatives considered

Depending on the complete upstream driver would simplify upgrades but does not meet the requirement for locally owned implementation. Copying browser and other platform code would add unsupported scope. The JSON operation protocol allows another native implementation without changing object consumers.

A CUA-specific persistent evaluator duplicates execution lifecycle policy and prevents independent iteration on PTC. Requiring callers to manage raw app and snapshot tokens alone loses reusable object semantics. The facade and small tool adapter provide those semantics while leaving the evaluator outside this package.

Reusing the MCP result adapter would impose MCP envelopes and wire validation on native CUA operations. Direct Harness tool output and shared attachment admission provide the needed logging and images without a second protocol.

**Fixing the screenshot format** would require otherwise unnecessary re-encoding and discard the attachment pipeline’s pass-through optimization. A format convention alone still forces callers to guess, and cannot tell them when encoding policy changes. Returning the already computed format and dimensions preserves pass-through and makes each result describe its actual bytes.

**Waiting until the full native-operation timeout** hides successful command dispatch behind a generic timeout. A separate configurable read budget reports the missing acknowledgement without treating slow applications as unsupported. Requiring every application to be foreground would claim a prerequisite that the available observations do not establish.

## Consequences

The package remains opt-in and macOS-only. Observations do not lock the desktop, and input success records dispatch rather than task completion. Callers must verify effects and must not retry uncertain input automatically. Native fixture tests verify actual window state separately from protocol and model-transcript tests. Persistent execution, binary distribution, permission onboarding and real-model task success remain separately owned work.

Source builds retain a content-addressed executable per compiled generation. The [shared helper decision](2026-10-09-cua-shared-native-helper.md) owns capture-client identity and cross-Host lifetime. Retained source generations avoid replacing a live executable, while the package payload remains separately published for distribution.
