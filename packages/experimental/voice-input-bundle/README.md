---
description: "Enable experimental speech input from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-voice-input-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle composes a speech Service Definition, local SenseVoice provider, authenticated Remote and browser microphone control. Shipped profiles leave it disabled.

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

Open Plugins in the Web sidebar and enable Voice Input, marked by a blue waveform icon. If models need preparation, a dialog offers Go to setup or Later; Go to setup opens the bundle details. Complete caches need no setup prompt. In the details, choose Download and prepare; the collapsed current-step summary expands to the complete step list. Downloads report actual bytes; verification and loading show elapsed time. Once ready, click the microphone between the model selector and Send, then Stop to insert a transcript. Bundle details store the recognizer and language through the Settings service. Disabling the bundle cancels active work; cached assets remain on disk.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The static `cordis.patch.yml` adds the four voice rows, selects `sensevoice-local` as the default recognizer and supplies the provider cache directory with `dshHomePath`. Optional-bundle installation makes the package available to management without selecting it in default profiles. The browser contribution owns its generated Remote mount; stable API Remotes do not import experimental code. No runtime invariant companion is published because this configuration-only package has no independently mutable runtime state.

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

- The initial bundle supplies one local recognizer. Additional providers register with the same service under distinct ids; cloud recognition requires an explicit new provider and credential configuration. The bundle does not add a model tool or change the agent loop.
- Installing dsh also installs `sherpa-onnx-node` and its platform-specific native runtime, including ONNX Runtime, even when this bundle is disabled. Runtime installation adds disk and download costs separate from the models downloaded by Download and prepare; the native package size varies by platform and version.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
