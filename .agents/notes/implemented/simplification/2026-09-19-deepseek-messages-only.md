# Agent Note: One Messages transport for the official DeepSeek route

Status: implemented

English | [中文](2026-09-19-deepseek-messages-only.zh.md)

## Problem

The official DeepSeek route needs Messages thinking replay, image uploads, and in-history updates. Selecting a second transport duplicates serializers, stream handling, Files wire formats, configuration branches, and fixtures without adding a required capability to this route.

## Decision

`dsh-llm-deepseek` uses Messages exclusively. One adapter resolves a request-local configuration snapshot and performs the request. Configuration exposes one endpoint and no protocol selector. The Files client uses Messages authentication, metadata, and pagination directly; quota cleanup scans every page before selecting the oldest owned files.

The [Messages adapter decision](../feature/2026-09-07-deepseek-messages-adapter.md) continues to own native thinking replay, system-message placement, image recovery, and request-extension acceptance. Replay discriminators and upload-index namespaces identify durable data and retain their existing values. The separate pi-ai adapter retains its provider-specific protocols.

## Alternatives considered

**Keep Chat Completions behind an optional selector.** This retains the duplicated implementation and test matrix even though the official route requires only Messages.

**Keep a generic protocol dispatcher with one implementation.** The dispatcher adds a second dependency representation and forwards every adapter operation without selecting anything.

## Consequences

The official route requires a Messages-compatible endpoint. Its mock-backed recovery, Loader, CLI, and Web tests exercise Messages; removing a wire implementation does not remove those behavior checks. Committed Session generations remain readable through provider-neutral content and the retained Messages replay metadata.
