# Agent Note: Shared-base Web fetch default

Status: implemented

English | [中文](2026-09-01-shared-base-web-fetch-default.zh.md)

This decision partially supersedes the fetch opt-in choice in [Default Web search in shipped compositions](2026-07-31-web-default-search.md). That record continues to own search provider selection, credentials, endpoint, timeout, and the separation between provider availability and model-tool registration; no active Agent Note is fully superseded or eligible for archival.

## Problem

Every shipped full agent product accepts anonymous public Web fetch, but `dsh-base` disabled `web_fetch` and required each application bundle to repeat the same override. The repeated configuration omitted ACP, made new base-backed profiles search-only unless their authors noticed the exception, and forced otherwise identical snapshot headers to split by product.

## Decision

`packages/bundle/base/cordis.patch.yml` mounts `dsh-tool-web` with `fetch: true` and the shipped 60-second search timeout. Headless, full SDK, ACP, and custom base-only profiles inherit both `web_search` and `web_fetch` without application-level overrides. The Web app disables the base tool row and composes the same pair per agent preset. The standalone `sdk-minimal` profile remains independent of base.

The base HTTP provider permits anonymous `http:` and `https:` requests only to validated public destinations. Fetch executes outside shell and filesystem sandbox or approval presets and requires no per-call approval; public-destination validation does not prevent public data egress. A product that requires a different network policy overrides the complete `tool-web` config in a later bundle or profile patch.

## Alternatives considered

**Keep fetch disabled in base and enable it in each product.** Rejected because every shipped full product selects the same capability, so the repeated rows encode no product difference and can omit future base-backed profiles.

**Add only an ACP override.** Rejected because it repairs the current omission while retaining three redundant application-level settings and the same failure mode for future profiles.

## Consequences

Base-backed model requests expose the fetch schema and prompt guidance by default, including ACP automation and custom profiles that name only `dsh-base`. Restricted deployments must opt out explicitly. Headless, SDK, and ACP can share the same model-header snapshot sources, while focused real-profile tests pin the shipped tool roster.
