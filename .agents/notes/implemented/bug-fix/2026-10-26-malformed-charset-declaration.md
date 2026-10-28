# Agent Note: Malformed charset recovery prefers UTF-8

Status: implemented

English | [中文](2026-10-26-malformed-charset-declaration.zh.md)

## Problem

A response can declare `charset=utf-8,gbk` over readable UTF-8 HTML. Passing that entire parameter to `TextDecoder` rejects the page before reading it. Compatibility needs an explicit encoding preference because successful decoding alone cannot identify the server's intended encoding.

## Decision

`decoderForCharset` preserves valid single-label declarations and the absent-header UTF-8 default. If a declaration is unsupported as a whole, it checks its comma- and whitespace-separated labels for UTF-8, including standard aliases. A match selects a fatal UTF-8 decoder; otherwise the declaration fails before the response body is read and the provider cancels the stream.

The provider decodes once. Recovery rejects invalid UTF-8 with `WEB_UNSUPPORTED_CONTENT_TYPE` and preserves the decoding error as its cause. Only an actual byte-cap truncation enables streaming decode, which omits an incomplete suffix and keeps `truncated: true`. Complete responses, including those exactly at the cap, validate the final sequence at EOF.

UTF-8 recovery is an explicit heuristic, not proof of the original encoding. The bytes `C2 A9` represent `©` in UTF-8 and `漏` in GBK; repeating them preserves that ambiguity at any length. The provider accepts that ambiguity for UTF-8 recovery but does not extend it to arbitrary legacy-encoding guesses.

## Alternatives considered

**Choose the first declared encoding that decodes.** A GBK body can also decode as `windows-1252` with different text. Declaration order does not resolve the conflict, and single-byte encodings can turn a decoding failure into silent corruption. Rejected.

**Use strict probes followed by ordinary decoding.** This decodes successful bodies twice. An unflushed streaming probe also accepts an incomplete EOF sequence that the ordinary decoder replaces. One fatal decode with explicit truncation state is sufficient.

**Read BOM and HTML meta declarations.** This would add HTML encoding identification and a dependency or parser, with a separate policy for missing metadata and non-HTML content. It remains deferred; the bounded UTF-8 preference resolves the reported response without claiming browser-equivalent detection.

## Consequences

- Malformed declarations containing UTF-8 can return readable text; a failed UTF-8 recovery never falls back to another encoding or inserts replacement characters.
- Malformed declarations without a UTF-8 label remain unsupported, including repeated legacy aliases. Valid single-label legacy decoding is unchanged.
- [`fetch-http.spec.ts`](../../../../packages/web/web-fetch-http/tests/fetch-http.spec.ts) covers recovery, conflicting labels, invalid bytes, EOF, truncation, and response-stream cancellation.
- The recorded [`web-fetch`](../../../../snapshots/session/web-fetch/snapshot.yml) scenario serves literal UTF-8 characters with `charset=gbk,utf-8` through the real HTTP provider and verifies the same model-visible text.
- HTML `<meta charset>` remains ignored. The package README documents the remaining ambiguity.
