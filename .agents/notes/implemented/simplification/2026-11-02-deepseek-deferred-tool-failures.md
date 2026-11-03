# Agent Note: Expose DeepSeek deferred-only request failures

Status: implemented

English | [中文](2026-11-02-deepseek-deferred-tool-failures.zh.md)

## Problem

A synthetic immediate tool can make an all-deferred DeepSeek request acceptable while hiding an invalid tool-update projection. It also changes the request prefix and advertises a tool with no executor.

## Decision

The DeepSeek adapter sends deferred declarations unchanged and propagates provider rejection. This replaces the placeholder accommodation described by the [tool-update decision](../architecture/2026-09-20-dynamic-tool-updates.md), whose shared history projection remains authoritative.

Ordinary addition-only histories start with native tools or an empty set. Removals and first additions to an empty set rebuild native declarations; later deferred additions retain a native baseline. Explicit deferred-only registrations, direct adapter calls, and custom in-history routes can still produce all-deferred requests. Those configurations receive no adapter workaround.

## Alternatives considered

**Keep a synthetic immediate tool.** It conceals unexpected deferred-only requests and cannot preserve a prefix that lacked that tool. Automatically activating a real tool instead changes its declared availability.

**Reject locally.** Provider validation owns acceptance; another local restriction would duplicate it. Reconsider accommodation only for a supported workflow that requires deferred-only requests and cannot retain a native declaration.

## Consequences

Deferred-only compatibility is deliberately given up so request errors remain visible. Serializer and HTTP tests verify exact declarations and propagation of a provider rejection. The all-deferred keyless snapshot verifies request construction only; replay success does not establish provider acceptance. Replacement and empty-set scenarios verify the supported addition-only path.
