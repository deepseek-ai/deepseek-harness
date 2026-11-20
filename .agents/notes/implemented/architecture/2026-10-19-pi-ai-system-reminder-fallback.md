# Agent Note: Pi-ai system reminder fallback

Status: implemented

English | [中文](2026-10-19-pi-ai-system-reminder-fallback.zh.md)

## Problem

Pi-ai concatenates later system messages into the initial prompt for models without native mid-conversation system support. Later system messages supplied to the adapter therefore invalidate the preceding conversation cache prefix.

## Decision

[Section-based updates](2026-10-21-section-based-system-updates.md) admit instruction deltas independently of native system-message support. This note owns their adapter representation on pi-ai routes.

The pi-ai adapter uses the prepared model's existing `supportsMidConvoSystemMessages` capability mapping. It preserves native system messages on capable models and converts each non-empty later system message into a user message wrapped in `<system-reminder>` otherwise, before pi-ai receives the context. Leading system messages remain in the initial prompt. System text blocks are trimmed and separated by blank lines. Message order and repeated updates remain intact, and durable messages retain their original roles.

The fallback belongs to the adapter because it depends on the selected protocol capability. The system service captures source deltas and the loop commits them; neither consolidates instructions solely because the route lacks native support.

## Alternatives considered

**Let pi-ai concatenate updates.** Retains system-role priority but changes the initial prompt whenever later system text changes, defeating prefix reuse.

**Advertise native support or send developer messages.** Misstates model capability or relies on another unsupported instruction role. The fallback uses ordinary user messages and does not change capability metadata.

## Consequences

The wrapper does not confer system-role authority, so reminders have user-role priority. Cache hits remain provider-dependent; tool changes and compaction can still invalidate prefixes. Both text-only and attachment-aware conversion apply the same fallback, and wire tests inspect the real pi-ai serializer output.
