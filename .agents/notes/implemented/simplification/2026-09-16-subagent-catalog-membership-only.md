# Agent Note: Keep model configuration outside subagent catalogs

Status: implemented

English | [中文](2026-09-16-subagent-catalog-membership-only.zh.md)

## Problem

The parent catalog serves direct-child discovery. Recording a child's creation-time LLM provider and model would preserve immutable configuration without opening child histories, but discovery and navigation consumers do not read those values. Creation configuration also does not establish which model served a request.

## Decision

The catalog event and projection retain child identity, creation time, mode, and label. `establishCatalogChild(parent, childHeader, descriptor)` receives only the values needed to publish membership. Child composition and request history retain their own model configuration; catalog loading adds no child observation or model lookup.

This decision supersedes only the creation-model metadata choice in the [parent-catalog decision](../architecture/2026-09-01-parent-owned-subagent-catalog.md). That note remains active for successful publication, event order, fork isolation, and projection ownership. The unreleased optional metadata declaration and its dedicated expectations are absent; existing historical Session generations from the migration base remain intact.

## Alternatives considered

**Keep optional creation metadata for future display.** Optional fields still require durable schemas, cache invalidation, producers, and replay expectations. A consumer requiring the immutable creation route could justify those costs; current consumers do not require it.

**Read child histories during discovery.** This adds work proportional to child histories without helping membership. A display that needs the model used by a request can observe the child's existing `modelSelection` projection independently.

## Consequences

The catalog provides no historical creation-route record. Reintroducing one requires a consumer whose requirement cannot be met by the existing child composition or request projections. Initial reads, live updates, reconnect, and authorization keep their existing owners. Catalog and creation tests, recorded-session replay, and both SDK expectations verify that membership still publishes without the extra metadata.
