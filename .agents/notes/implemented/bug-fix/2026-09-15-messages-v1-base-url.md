# Agent Note: Exact v1 recognition for Messages base URLs

Status: implemented

English | [中文](2026-09-15-messages-v1-base-url.zh.md)

## Problem

The Messages transport appends the Anthropic-standard `/v1` namespace to a configured base URL. A base that already ends in `/v1` previously produced `/v1/v1/messages`, while recognizing every `v`-plus-digit suffix as a provider version granted undocumented compatibility and could bypass the standard namespace.

## Decision

The shared Messages API owner trims trailing slashes and treats only a final path segment exactly equal to `v1` as the existing API version. It preserves that root and appends `/messages` or `/files`; every other base receives `/v1/messages` or `/v1/files`. The same resolved root scopes cached file uploads. The official `https://api.deepseek.com/anthropic` base therefore resolves to `/anthropic/v1`, and an explicit `/anthropic/v1` base remains unchanged.

The Messages rule does not infer support for `v1beta`, `v2`, `v4`, or other version-like suffixes; deployments that include those segments receive the standard `/v1` namespace beneath them.

## Alternatives considered

**Recognize any final segment beginning with `v` and a digit.** This avoids repetition for more custom endpoints, but it turns a narrow duplicate-`v1` repair into an undocumented compatibility policy and can route requests outside the Anthropic-standard namespace.

**Always append `/v1`.** This follows the standard path for unversioned roots but preserves the original duplicate path for callers whose configured base already ends in `/v1`.

## Consequences

Messages, Files, and file-cache identity use one deterministic rule. Exact `/v1` configurations remain compatible without changing the recommended unversioned base. Other version-like suffixes are not treated as API versions and therefore resolve beneath an added `/v1`; this deliberately gives up speculative proxy compatibility.
