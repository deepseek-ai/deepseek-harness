---
kind: upgrade-guide
description: "The cordis_inspect tool replaces cordis_inspect_list and cordis_inspect_query."
---

# Use one Cordis inspection tool

English | [中文](guide.zh.md)

## Change

`cordis_inspect` replaces `cordis_inspect_list` and `cordis_inspect_query`. Custom prompts, skills, and tool callers that name either old tool must use the new name and arguments. An omitted `query` returns the provider directory; a supplied `query` selects a provider method.

## Migration

1. Replace `cordis_inspect_list({})` calls with `cordis_inspect({})`.
2. Replace `cordis_inspect_query({ platform, provider, method, input })` calls with `cordis_inspect({ query: { platform, provider, method, input } })`. Keep `platform`, `provider`, and `method` inside `query`; `input` remains optional.
3. Confirm that `cordis_inspect({})` returns a provider directory. Select a provider and method from that directory, supply arguments matching its input schema under `query.input`, and confirm that the query returns the requested data. Client queries require a connected page.
