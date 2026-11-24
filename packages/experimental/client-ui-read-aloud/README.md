---
description: "Read assistant replies aloud from the message action row, requesting synthesis as playback advances."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-read-aloud

English | [中文](README.zh.md)

## Summary

This Client plugin adds a Read aloud control to the action row under each finalized assistant reply. A click reads the reply through the [`readAloud` Remote](../read-aloud/README.md) and plays the audio in the browser. The plugin requests one segment at a time, each only when little of the received audio is still unplayed, so stopping early leaves the later segments unsynthesized and unbilled.

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

The [read-aloud bundle](../read-aloud-bundle/README.md) enables this row. The control shows a speaker while idle, four pulsing bars from the click until sound and while playback waits for audio, and a moving waveform in the business color while the reply is read. Its tooltip is Read aloud, or Stop reading during a reading, and a second click stops. Starting another reply stops the one in progress.

The control appears only while the Host reports synthesis `ready` and the current Peer may call `readAloud/synthesize`; without a DeepSeek account sign-in or API key it is absent. It stays for the message being read, so a reading can always be stopped. A row that is otherwise shown on hover or focus stays visible while its reply is read.

A failure ends the reading after the audio already received has played, and a toast over the composer names the cause. After a failure that may pass (a busy or unreachable service, a timeout, an interrupted reply), the next click on the same reply continues at the failed segment. Leaving the Session stops its reading and discards its notice.

The bundle's details hold the voice preference: a field lists the provider's voices, and choosing one saves it on the Host for readings started afterwards; a choice that was not saved is reported under the field. The speaker beside the field plays a short sample sentence in the saved voice with the same three states as the control, and its failure is reported as a toast; it is disabled while no credential is available, and leaving the details stops it. A reading and a sample replace each other. The details also state that synthesis is billed per submitted character, list the languages the service reads and that it detects the language from the text, link DeepSeek's speech synthesis guide in the UI language, and offer sign-in while no credential is available.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`Reader` owns one reading. It asks the Host for the plan, then for each segment waits until the player holds at most `dispatchBelowMs` of unplayed audio, opens the segment's stream, and queues each frame. A timer wakes when the queue should have run out: if more audio is expected, the phase returns to `loading`. A run that was stopped is recognized by identity, so frames and failures that arrive afterwards change nothing.

`createPcmPlayer` opens one `AudioContext` per reading while the click is handled, converts each frame to a buffer, and starts it exactly where the previous one ends. Closing stops the queued sources and releases the output.

The control registers as `read-aloud` in `conversation.chat.assistant-actions` (order 20, after the rating pair), the notice as `read-aloud-notice` in `conversation.input.overlay`, and the details under the bundle's key in `plugins.bundle.config`. All three share one `Reader` and one availability mirror. The control carries `data-action-ongoing` during a reading, the attribute `ui-chat` reads to keep a hover-revealed row visible.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Read-aloud subsystem](../../../docs/subsystems/read-aloud.md) · [Segment pacing decision](../../../.agents/notes/implemented/feature/2026-11-23-read-aloud-segment-pacing.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the control plays transient audio in the browser and submits nothing to the Agent.

#### KV Cache effect

No effect; no model request, message, or Session event changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- There is no pause, progress display, or speed control, and one reading runs at a time. A reading stops when its Session leaves the screen, which includes layouts that unmount the composer. Playback needs a browser that lets the page open an audio output after a click. The notice is shown only while its Session is on screen.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

`tests/reader.client.spec.ts` drives the pacing loop with fake timers and an audio clock tied to them. `tests/player.client.spec.ts` uses a stand-in `AudioContext`. `tests/components.client.spec.tsx` renders the control, the notice and the details, and `tests/mount.client.spec.ts` covers registration and disposal. `src/client/index.ts` imports generated Remote definitions and is exercised by `apps/web/tests/read-aloud.e2e.ts`.

</details>
