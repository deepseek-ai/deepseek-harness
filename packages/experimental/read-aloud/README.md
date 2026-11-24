---
description: "Plan and synthesize assistant replies one segment at a time for paced read-aloud in browser clients."
kind: "package-reference"
---

# @deepseek-ai/dsh-read-aloud

English | [中文](README.zh.md)

## Summary

`ctx.readAloud` serves the experimental `readAloud` Remote namespace. It locates one finalized assistant message in the stored Session log, reduces its Markdown to the text a voice reads, cuts that text into segments of about 30 seconds, and synthesizes one segment per call through `ctx.textToSpeech`. The Client asks for the next segment only as playback approaches the end of the audio it holds, so text the listener has not reached is never submitted. Read-aloud adds no Session event and no model input.

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

The [read-aloud bundle](../read-aloud-bundle/README.md) enables this row. `segmentSeconds` (30, from 5 to 300) is the estimated spoken length of the text one synthesis request carries. `dispatchBelowSeconds` (15, from 1 to 300) is how much received audio may remain unplayed when the Client requests the next segment. Shorter segments leave less paid audio unheard after an early stop and cost more requests and more restarts of intonation.

`follow(signal)` streams the status once per change: `ready`, `sign-in-required`, or `unavailable`, and, while the configured provider is registered, its voice ids, the saved voice, and the sample rate. `configure({ voice })` saves the voice for later readings. `plan({ sessionId, messageId })` returns the message's log position, its segments as ranges of the read-aloud text, `dispatchBelowMs`, the sample rate, and the voice saved at that moment; no text leaves the Host. `synthesize({ sessionId, messageId, seq, voice, start, end })` streams frames of 200 ms of base64 16-bit mono PCM for one planned segment in the plan's voice, so one reading keeps one voice. `sample({ voice, language })` streams the same frames for a fixed sentence the Host owns (Chinese, English, or Japanese; any other language hears the English one), so a listener can compare voices.

Paragraphs, headings, quotes and list items are read as one line each. Emphasis, links and inline code keep their text. Code blocks, tables, images, HTML, rules, block formulas and footnotes are left out, and an inline formula is read only when it has at most 20 characters. A block formula is the text between `$$` pairs. An inline formula is the text between two `$` on one line whose opening `$` precedes a non-space character and whose closing `$` follows a non-space character and precedes no digit, so an amount such as `$20` stays text; dollars in code and HTML delimit nothing. A reply without a letter or digit in what remains has no segments.

`plan` and `synthesize` reject with `readAloud/message-not-found` when the Session holds no such assistant message. `synthesize` rejects with `readAloud/stale-plan` when the range is not a segment of the message under the current configuration, and with `readAloud/synthesis-failed`, carrying the provider's failure code when it classified one.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

A segment closes at a sentence end once its estimate reaches `segmentSeconds`, at a clause mark or space from 1.5 times that, and anywhere from twice that. A remainder estimated at half the target or less stays in the segment before it, and no segment exceeds the provider's `maxCharacters`. Text without a letter or digit before, between or after segments is in no segment. The estimate counts 200 ms for an ideograph, kana, Hangul syllable or digit, 70 ms for any other letter, 300 ms for a sentence end and 150 ms for a clause mark. The rule and the numbers follow the DeepSeek chat service; the decision note explains the choice.

The message is read from storage in windows of 256 events: backward from the end when the log length is known, forward otherwise. A live Session is flushed first. `plan` reports the event's sequence number, and `synthesize` reads that one event and checks its identity. The controller keeps no reading state: each call derives the text and the segments again, which is why a changed configuration surfaces as `readAloud/stale-plan`.

Both reading methods declare the Session they name as their access resource, and the liveshare viewer classification lists the namespace as owner-only because synthesis is billed to the owner. The Client's cancellation ends the provider request.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Read-aloud subsystem](../../../docs/subsystems/read-aloud.md) · [Segment pacing decision](../../../.agents/notes/implemented/feature/2026-11-23-read-aloud-segment-pacing.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as read-aloud reads stored replies and returns transient audio outside model requests.

#### KV Cache effect

No effect; no model request, message, or Session event changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only a finalized assistant message can be read; a reply that is still streaming cannot. A formula written with the TeX delimiters `\(…\)` or `\[…\]` is read as ordinary text, and so is one whose dollars are padded with spaces on the inside, as `$ x $`. Prose that mixes a leading and a trailing dollar on one line, as `$5 … 4$`, is still taken for a formula. The estimate is tuned for Chinese and English and is not measured audio, so a segment's real length differs from `segmentSeconds`. Each segment is a separate synthesis, so intonation restarts at a segment border. A Session whose storage backend reports no event count is searched from its first event.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

`tests/segments.spec.ts` pins each closing rule, `tests/speech-text.spec.ts` the Markdown reduction, `tests/message.spec.ts` the windowed search, and `tests/controller.spec.ts` the Remote methods over a stored-log double. `apps/web/tests/read-aloud.e2e.ts` runs the shipped composition against a loopback synthesis double.

The build embeds the Markdown parser in the package entry and the manifest lists it under `devDependencies`. Installed as a runtime dependency, a Host inside a Web Worker resolves the parser's browser build, which reads `document` on import. The math syntax packages stay out because they install KaTeX; `speech-text.ts` finds formulas by their dollar delimiters instead.

</details>
