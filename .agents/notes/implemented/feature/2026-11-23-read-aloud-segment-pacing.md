# Agent Note: Read-aloud paces synthesis by segments in the Client

Status: implemented

English | [中文](2026-11-23-read-aloud-segment-pacing.zh.md)

## Problem

Users asked for assistant replies to be read aloud. DeepSeek publishes speech synthesis as `POST /v1/tools/tts` and as a WebSocket on the same path. The API bills every character it is given, where a Chinese character counts two, and synthesizes many times faster than a voice reads. A reading that submits a whole reply and is stopped after a few sentences therefore pays for the entire reply.

The DeepSeek chat service avoids this in its own backend: its Client reports playback progress, and the backend submits text to the synthesis vendor only as playback advances. The public API has no progress report, so it submits whatever it receives at once. Its backend documentation states that text handed to the vendor is billed even when the request is cancelled. The backend team decided not to change the public protocol and asked DSH to pace on its side with the public API.

## Decision

DSH paces by segments, and the browser decides when the next one is due. The Host cuts a reply's read-aloud text into segments and synthesizes exactly one segment per request with `POST /v1/tools/tts`. The Client requests the next segment once the audio it has received has at most `dispatchBelowSeconds` left to play. Stopping cancels the request in flight and submits nothing further, so the cost of an early stop is bounded by the segments already requested: at most one segment plus `dispatchBelowSeconds` of audio beyond what was heard.

This is the chat backend's current scheme, segment dispatch, moved to where the playback position is known. That backend gives every segment its own vendor session, closes a segment at a sentence end by estimated spoken length, and dispatches the next one when unplayed audio falls to a low watermark. One public API call is one vendor session, so one request per segment is the same unit. DSH keeps that backend's estimate (200 ms for an ideograph or digit, 70 ms for another letter, 300 ms for a sentence end, 150 ms for a clause mark), its closing rule (a sentence end at the target, a clause mark at 1.5 times, anywhere at twice, a short remainder absorbed) and its low watermark of 15 seconds.

Segments target 30 seconds each by default, where the chat backend uses 30 seconds for the first segment and 60 for later ones. One value is one setting to explain, and a shorter later segment lowers the cost of a late stop at the price of more requests. `segmentSeconds` and `dispatchBelowSeconds` are configuration of the `read-aloud` row.

The Host owns text and credentials. It finds the reply by message identity in the stored Session log, converts Markdown to speech text itself, and sends that text with `filter_markdown: false`. The Host must know exactly which characters are spoken to estimate length, and a segment made only of a code block would otherwise be billed as a request that the service rejects for having nothing to read. The Client receives ranges and audio, never text, and the Host accepts only ranges that are segments of the named message.

The interface is one control in the message action row, as in the chat app: a speaker, a loading mark until sound, and a waveform while reading. It appears only while a credential is available. Failures are reported in a toast, and a failure that may pass leaves the reading resumable at the failed segment, so the listener does not pay again for what was already heard.

The voice is a saved preference. The synthesis API offers two voices; the bundle's details list them beside a control that plays a fixed sample sentence. The choice is saved in the registry's profile entry, as voice input saves its language, and a plan fixes the voice for its whole reading, so a reply is never read in two voices.

## Alternatives considered

Submitting the whole reply in one request is the simplest use of the API and is the case the pacing exists to avoid.

Feeding one WebSocket session sentence by sentence was rejected. The session ends after 60 seconds without text, so a wait between sentences has a deadline. With the service's Markdown filter a paragraph is released only at a blank line, and fragments without punctuation wait for later text. The chat backend itself keeps continuous submission into one session only as a fallback that configuration enables per vendor.

Pacing in the Host was rejected because the playback position exists only in the browser; it would need the progress reports that the chat protocol carries and the public API was not given.

Automatic reconnection and resumption after a network drop, which the chat backend supports with frame sequence numbers and a retention window, were left out: a failed segment is requested again by the next click.

## Consequences

A segment border is a new synthesis request, so intonation restarts there. A reading makes several requests, each counted against the account's concurrency limit of the synthesis API one at a time. The segment estimate is not measured audio; real segment lengths differ by voice and language. A reply that the service ends cleanly before all audio was sent cannot be detected, because the PCM stream carries no length. Reading while a reply is still streaming, automatic reading of new replies, pause and speed are not part of this decision. The API accepts neither a language nor a speech rate, so the interface offers neither.
