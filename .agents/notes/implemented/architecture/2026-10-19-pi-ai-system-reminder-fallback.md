# Agent Note: Pi-ai system reminder fallback

Status: implemented

English | [中文](2026-10-19-pi-ai-system-reminder-fallback.zh.md)

## Problem

Pi-ai concatenates later system messages into the initial prompt for models without native mid-conversation system support. Later system messages supplied to the adapter therefore invalidate the preceding conversation cache prefix.

## Decision

The pi-ai adapter uses the prepared model's existing `supportsMidConvoSystemMessages` capability mapping. It preserves native system messages on capable models and converts each non-empty later system message into a user message wrapped in `<system-reminder>` otherwise, before pi-ai receives the context. Leading system text remains in the initial prompt. Message order, repeated updates, and existing text-block concatenation remain intact. Durable messages retain their original roles.

The fallback belongs to the adapter because it depends on the selected protocol capability. Prompt admission remains owned by the agent loop, which consolidates system-prompt updates on routes without native support; this fallback only handles later system messages present in the supplied request.

## Alternatives considered

**Let pi-ai concatenate updates.** Retains system-role priority but changes the initial prompt whenever later system text changes, defeating prefix reuse.

**Advertise native support or send developer messages.** Misstates model capability or relies on another unsupported instruction role. The fallback uses ordinary user messages and does not change capability metadata.

## Consequences

The wrapper does not confer system-role authority, so reminders have user-role priority. Cache hits remain provider-dependent; tool changes and compaction can still invalidate prefixes. Both text-only and attachment-aware conversion apply the same fallback, and wire tests inspect the real pi-ai serializer output.
