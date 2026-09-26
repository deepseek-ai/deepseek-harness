---
description: "Prepare and operate a local CPU SenseVoice worker on demand."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-speech-to-text-sensevoice

English | [中文](README.zh.md)

## Summary

This provider recognizes speech with SenseVoiceSmall ONNX and Silero VAD on the Host CPU. The platform-specific sherpa-onnx Node package includes ONNX Runtime; users need no Python, compiler or model conversion. Activation checks cached resources without loading models or downloading assets.

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

The [bundle](../voice-input-bundle/README.md) supplies an absolute `dataRoot` under the DSH home. Preparation downloads revision-pinned model files, verifies their sizes and SHA-256 hashes, then loads them. `precision` defaults to `int8`; `fp32` selects the larger reference weights. `modelDirectory` supplies an existing absolute directory containing the selected ONNX file and `tokens.txt`; `vadModelPath` selects an existing Silero ONNX file. Verified completed files remain reusable after cancellation or failure.

Before each missing asset is downloaded, the Host compares the Hugging Face-compatible `modelOrigins`, which default to `https://huggingface.co` and [HF-Mirror](https://hf-mirror.com). Concurrent HEAD requests follow the pinned file path and redirects through the Host's fetch proxy; the first 2xx response is tried first. `modelProbeTimeoutMs` defaults to 3000 ms; when every probe fails, downloads use the configured order. Network, HTTP, certificate and integrity failures try the remaining sources; cancellation, storage failures and unclassified failures stop preparation. Pinned revisions, sizes and SHA-256 hashes apply to every source. Response latency does not measure download throughput; the preparation deadline still bounds the complete download.

An explicit `modelOrigin` uses only that origin, without probing or public fallback. A single-entry `modelOrigins` also skips probing. Verified caches and explicit offline paths require no source requests. The voice UI offers the advertised sources before preparation or retry. A manual choice overrides selection for that task only, uses one source without fallback, and cannot replace an active task’s source. The Host rejects choices outside its configured origins; fully offline deployments advertise no download sources.

Download failures identify the asset and source origin, with a classified cause and HTTP status or diagnostic code when available. The public state omits URL credentials, query strings and raw cause messages. Retry reuses verified files; partial downloads restart.

Every activation checks the selected model, tokens and VAD on disk. Complete verified caches restore readiness immediately after inspection; the first recording wakes the worker. Missing files or mismatched managed checksums require explicit preparation, while unreadable paths report an error. Explicit deployment paths are checked for accessibility; their contents remain the deployer's responsibility. Disabling the plugin or restarting the Host does not require downloading intact caches again.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

One managed Node subprocess serializes inference. Recordings submitted during wake-up join the bounded queue. At execution, the worker requires ready or standby resources. Transcription never starts preparation downloads. `threads`, `segmentSeconds`, `vadThreshold`, `minSpeechSeconds` and `minSilenceSeconds` tune CPU inference and segmentation; `maxPending` bounds accepted work. Preparation and inference have separate deadlines. Invalid language or WAV input is rejected before native inference and retains the loaded worker; inference failures, malformed responses and transport failures reclaim it. Cancellation terminates an active worker and joins its process range; cancelled queued recordings never run. `idleTimeoutMs` releases the worker after inactivity, with zero retaining it until disposal. Models remain cached. Authenticated loopback requests keep audio in memory. Electron workers run in Node mode and copy VAD buffers to satisfy the V8 memory cage. No runtime invariant companion is published because `dsh-subprocess` owns process-range observations and this provider has no independent projection to reconcile.

The Host owns preparation across page and Session changes: check resources, download recognition weights and tokens, download VAD, verify files, and load the worker. Explicit model paths omit their download steps. Downloads report bytes; other steps report elapsed time. An idle worker retains prepared paths and needs only model loading on wake-up. Cancellation after a preparation result is published waits for cleanup without replacing that result.

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

- CPU only. Native packages target macOS arm64/x64, Linux glibc arm64/x64 and Windows x64; Windows ARM64 and Linux musl are not verified deployment targets. INT8 weights occupy about 239 MB, FP32 about 938 MB, plus the runtime and VAD. Model memory exceeds file size and grows with recording length; installation hints are estimates. Language hints are auto, Chinese, English, Cantonese, Japanese and Korean. Disabling the plugin retains model caches. Packaged Desktop releases still require platform signing and microphone-permission acceptance; Linux Desktop distribution is outside this provider.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
