# Agent Note: Paid native Flash translation uses independent queries

Status: implemented

English | [中文](2026-10-05-paid-native-flash-reasoning-translation.zh.md)

## Problem

Readers may choose model-based translation in exchange for additional charges. Reusing their conversation request would inherit its history and generation controls, while routing through an arbitrary configured model would conceal the translation's billing and receiver choices.

## Decision

Paid translation is an explicit alternative to the [default anonymous path](2026-10-05-anonymous-reasoning-translation.md). Only active built-in `deepseek-account` and `deepseek-official` owners with configured credentials and the exact `deepseek-flash` catalog ID qualify. Display names and versions do not participate, and pi-ai routes are excluded. Each fragment receives one fresh text-only query, a simple translation instruction and disabled thinking; no previous fragment or main history is supplied.

The original Session keeps `plugin:translator/request`, the [shared translation request record](2026-10-05-persistent-machine-translation.md), with exact model-visible input in optional `metadata.modelRequest` before dispatch. The existing `appendPluginRecord` writer snapshots its JSON payload and marks it ignorable without replacing main history. Read-only cache lookup precedes native admission and needs no live Session. A cache miss uses the active Session writer and flushes before dispatch; the GUI joins normal Session activation when needed, with its ordinary startup and resume effects. Format migration retains these informational records on a best-effort basis. Translation does not supply the main Session identity to the native request extensions, so a fragment cannot authorize uploading its full conversation log. The configured paid choice is enforced by the Host before billing.

## Alternatives considered

**Reuse the conversation's model call.** Its history, model and thinking settings are unrelated to a translation fragment, and session-log delivery could transmit more than the selected text. A fresh native Flash call makes these choices explicit.

**Offer every model or version label.** This requires additional receiver and billing decisions. The stable `deepseek-flash` ID supports future versions while preserving the requested built-in route restriction.

**Replace the original assistant output.** Translated text is retained separately as a shared result record; original reasoning remains the source of main model history.

## Consequences

Paid queries consume additional input and output tokens. The GUI discloses billing for uncached fragments. Reopening reuses persisted successful results, including when native credentials or model configuration are unavailable. Failures never choose another route. Local audit retention is independent of provider log delivery, and anonymous translation remains the default.
