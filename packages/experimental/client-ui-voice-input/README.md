---
description: "Record speech and insert reviewable transcripts into the conversation draft."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-voice-input

English | [中文](README.zh.md)

## Summary

This optional browser plugin adds an outline microphone icon between the model selector and Send. When recognition is ready, clicking it opens a recording toolbar with measured audio levels, Cancel and Stop. The waveform stays shorter than the recording buttons. Stopping transcribes into the draft. Recognition preferences and model preparation live in plugin settings; language choices come from the selected provider.

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

Enable the [voice input bundle](../voice-input-bundle/README.md) from Plugins. After cache inspection, missing models trigger a setup prompt with Go to setup and Later actions. Go to setup opens bundle details; Download and prepare starts installation there. Intact cached models need no prompt or repeated installation. Before recognition is ready, guidance appears only on click, with no microphone tooltip. Clicking the microphone opens the same guidance dialog; its action opens the voice bundle details without recording or downloading. Cache inspection, preparation in progress, failures and disconnected services instead offer navigation to status, progress or error details. The dialog moves focus to its navigation action and keeps Tab traversal inside it; Later or Escape restores the previous focus without changing or submitting the draft. Before preparation, local providers can show their estimated disk, memory and setup-time requirements. The preparation summary starts collapsed; expand it to inspect completed, current and pending steps. Once ready, click the microphone, allow access and click Stop to transcribe. Cancel or Escape discards capture. Recognition feedback stays inside the toolbar. Provider and language preferences are saved from bundle details through the Settings service. Browser microphone access requires HTTPS or loopback and operating-system permission.

Before downloading or retrying, **Model download source** offers Automatic and the origins advertised by the Host. SenseVoice normally offers Hugging Face and HF-Mirror; a fixed private deployment exposes only its configured origin. Manual selection uses only that source, while Automatic preserves the provider’s comparison and fallback policy. The choice is retained for retries in the current card, without changing deployment configuration or recognition preferences. Source controls are unavailable during preparation and hidden when resources are ready.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

Native MediaRecorder captures audio and Web Audio converts it to the Host PCM format after flushing the final recorder chunks. Window blur during the microphone permission request does not cancel capture; blur during recording does. Capture failures immediately end the recording UI and offer retry inside the toolbar. Cancellation, failure and plugin disposal share one resource-release promise; the plugin retains ownership until AudioContext closure settles. The original editor selection carries a draft revision: changed drafts retain the transcript for explicit insertion or discard beside the microphone. Session changes, hiding the page during capture and plugin disposal invalidate late results and release tracks. One plugin-owned readiness subscription serves the composer, installation prompt and details. These views use the existing Slot lifecycle and own no preparation tasks. No runtime invariant companion is published because readiness comes from one Host subscription and recording state belongs to one capture operation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Voice input subsystem](../../../docs/subsystems/voice-input.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as recordings and preparation remain outside model requests; ordinary user submission owns any later text.

#### KV Cache effect

No direct effect; ordinary submission owns the message content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No automatic send, always-on microphone, wake word, streaming captions or speech synthesis. “Local” means the Host machine, which can differ from the browser’s machine.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
