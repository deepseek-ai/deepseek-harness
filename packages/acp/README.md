---
description: "The Agent Client Protocol package group: the automation-only server that exposes fresh harness agents to programmatic clients over JSON-RPC stdio."
kind: "package-group"
---

# acp/ — Agent Client Protocol automation

English | [中文](README.zh.md)

## Summary

The acp group provides one package: a server that lets programs and automation run persistent DeepSeek Harness agents over the standard Agent Client Protocol. A client can create, list, resume, and close sessions; attach standard MCP servers; select model options; send text and image prompts; receive semantic updates; answer permission prompts; and cancel work without a human in the loop. The matching client for spawning such a server from another harness lives in `subagent/subagent-acp`. This page maps the group; the package README owns the per-package contract.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`acp/`](acp/README.md) | Lets programs manage persistent agents over ACP, attach MCP servers, select model options, prompt and cancel work, and receive semantic updates |

-----

<a id="related-documentation"></a>
## Related documentation

- [dsh-subagent-acp](../subagent/subagent-acp/README.md) — the out-of-process ACP client that spawns and drives this server.
- [ACP as an automation-only protocol](../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md) — the design record for the automation contract and its wire boundaries.
- [Multiplex concurrent ACP sessions over one connection](../../.agents/notes/archived/feature/2026-06-14-acp-multi-session.md) — per-session isolation, ownership, and teardown decisions.

<a id="dev-note"></a>
## Dev Note

None.
