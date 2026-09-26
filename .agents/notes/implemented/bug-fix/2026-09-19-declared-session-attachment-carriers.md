# Agent Note: Declared Session attachment carriers

Status: implemented

English | [中文](2026-09-19-declared-session-attachment-carriers.zh.md)

## Problem

Session attachment authorization and ZIP export inferred attachment ownership from common payload field names. An unknown ignorable event could therefore authorize an image read or export file bytes. Compaction content under `summary` and `rawOutput` was outside that field-name scan.

## Decision

Both consumers select content fields by built-in event type. They inspect completed assistant blocks and direct content blocks, including flat V4 tool-role messages. Other content-block fields and unknown event payloads remain opaque, even when they contain objects resembling image or file references.

The controller applies this rule before reading image bytes. The exporter applies it before reading image or file bytes and retains the complete logical log. Historical logs reach these readers after persistence converts them to current logical events. Title requests are excluded because V4 requires a single text block. Compaction uses its declared content fields: the basic producer currently emits text, while other valid compaction producers may supply attachments there.

## Alternatives considered

**Scan common keys on every event.** This lets a field name grant attachment access without a defined content meaning. It also misses valid content stored under other declared fields.

**Interpret historical wrappers in attachment readers.** Historical conversion belongs to the adjacent format packages. Current attachment readers use flat V4 content and do not maintain a second interpretation of old blocks.

## Consequences

Plugins that store attachments only in custom events cannot use these built-in readers for those references. A plugin needs a supported content occurrence or its own reader. Adding a built-in content carrier requires updating both readers and their acceptance and refusal tests. Historical codec inventories remain version-owned; changing this policy must not change what a released decoder recognizes.

The change affects attachment lookup and archive membership, not Session encoding or the model-visible message history.

## Verification

Controller and archive tests cover declared carriers, flat tool results, opaque plugin payloads, and misleading extra fields. Refusal tests assert that attachment storage is never read; archive tests also compare the exported log text.
