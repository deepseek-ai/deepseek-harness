# Agent Note: Experimental voice input with explicit recognition providers

Status: implemented

English | [中文](2026-09-16-experimental-voice-input.zh.md)

## Problem

Dictation must preserve user control over when a coding task starts. Local recognition brings model files, a native runtime and CPU work; merely installing or enabling a UI contribution must not allocate these resources. Later cloud providers need a selection mechanism that does not silently change where recordings are processed.

## Decision

Five public packages under `packages/experimental/` compose one optional, default-disabled voice input bundle. Service Definition, SenseVoice Provider and Remote Consumer are separate because provider deployment and browser transport evolve independently. The browser UI dynamically mounts its generated Remote contribution. Stable API Remotes do not acquire an experimental dependency.

Provider ids select exact registrations. Resolution captures an instance, and deregistration closes admission, cancels and joins accepted work. There is no provider fallback: a local failure cannot authorize uploading speech to a cloud service. A new cloud provider supplies its own credentials and explicit processing location through the same registry.

Recordings and transcripts remain transient until the user submits ordinary text. Recognition does not start an agent turn or create an audio Session event. The input facade accepts asynchronous plain text against a captured draft revision, preserving reference chips and undo history. Changed drafts retain the recognized text for explicit insertion instead of replacing later edits. Session changes and plugin disposal invalidate late results and release recording resources. Capture failures notify the current recording activity immediately, independently of resource-close latency. Cancellation, failure and plugin withdrawal join one release promise, so ownership lasts until the AudioContext closes.

SenseVoice ONNX and Silero VAD run in one managed CPU subprocess. The native sherpa-onnx package includes ONNX Runtime; explicit preparation only downloads and verifies models; subsequent calls reuse the warm model until the configured idle deadline. Every activation verifies cached assets and restores complete caches to standby without starting the worker. Readiness therefore follows disk contents rather than the lifetime of a Provider instance. Recordings wait in the bounded queue during wake-up. The worker checks readiness at execution, so queued work cannot implicitly download resources invalidated by an earlier cache inspection. Inspection uses the same owned task as preparation, so cancellation and disposal join it. Disabling the provider joins its work and process exit while retaining reusable disk assets. Native browser recording and resampling avoid an additional audio conversion executable. The authenticated private loopback protocol carries complete PCM recordings, allowing cancellation to terminate the worker without sharing a long-running inference with another request.

The Host owns preparation independently of the view that started it. An ordered step list survives view remounts and records completion only as execution advances. Recognition weights, VAD and final verification have separate operations; downloads use pinned byte counts, while other work reports elapsed time. Preparation status and progress stay in bundle details through `plugins.bundle.config`, keyed by package name. The generic `plugins.bundle.activation` slot carries explicit enablement intent and detail navigation; the voice occupant waits for Host cache inspection and offers installation guidance only for unprepared local models. Enabling an already prepared provider does not prompt or download. A single composer activity Slot expands the voice controls while preserving the draft editor and submit action. The context meter sits below the composer; recording and transcription hide the meter along with ordinary toolbar controls until the activity closes. Shared primitives provide buttons, disclosure and status markers; only measured waveform drawing belongs to the voice UI. Recordings start on click and transcribe on Stop, with feedback inside the activity. Persistent preferences remain in plugin settings.

## Alternatives considered

Always loading the model on plugin activation would make a UI toggle incur substantial startup time and memory even without dictation. Python/FunASR/PyTorch adds interpreter provisioning, dependency installation and disk cost; completed ONNX artifacts and platform-native packages serve CPU dictation. End users never export models. Browser-native speech recognition does not provide a uniform local-processing guarantee. Streaming voice interaction would require partial-result revision, turn arbitration and bidirectional audio semantics that complete-recording dictation does not need.

## Consequences

First use needs download time and disk space. Local means the Host machine, including a remote Host. A cancelled active inference loses its warm worker and the next request reloads it. Optional preparation paths support existing offline environments without silently changing defaults.

Verification covers exact-provider routing, registration teardown, bounded audio parsing, microphone release, stale-draft and Session-switch handling, worker queue/deadline recovery, and verified download publication. Real local inference uses the same managed worker as the product. Browser composition verifies optional enablement and draft insertion; ordinary Session replay verifies that only the submitted text reaches the model.

Real Node 24 and Electron 44 children complete FP32 and INT8 inference. Electron copies VAD output to avoid external-buffer restrictions. Three runs of the 4.2-second public Chinese sample agree; this short sample is not a complete accuracy evaluation. Desktop microphone requests are restricted to audio from the primary application window, with macOS authorization handled by the operating system. Windows, Linux and signed installers still require platform acceptance.

INT8 is the default to reduce download and storage cost; `precision: fp32` selects the reference weights. Public English and concatenated bilingual samples show word differences between precisions, so quantization is not treated as accuracy-equivalent. A roughly 101-second repeated-speech sample completes in both runtimes; its observed post-request RSS is not a peak-memory bound.
