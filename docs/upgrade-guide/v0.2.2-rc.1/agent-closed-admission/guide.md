---
kind: upgrade-guide
description: "Agent input and maintenance methods throw AgentClosedError once the Agent stops accepting new work."
---

# Handle Agent input rejected during shutdown

English | [中文](guide.zh.md)

## Change

In v0.2.2-rc.1, a retained `Agent` could accept input while teardown was in progress. The Agent now rejects new input and maintenance work with `AgentClosedError` as soon as its lifetime is aborted. It can still appear in the registry while admitted work settles.

## Migration

1. In extensions that call `Agent.send`, `followup`, `steer`, `inject`, or `runMaintenance`, handle the synchronous `AgentClosedError` from `@deepseek-ai/dsh-agent` at the call site. Treat code `AGENT_CLOSED` as an unavailable Agent and preserve handling for other failures.
2. Verify by disposing an Agent with a maintenance task still settling. A subsequent input call throws `AgentClosedError` without adding an inbox entry.
