---
description: "The test-support group map: keyless test harnesses, LLM mock and replay servers, and Loader smoke helpers for developers writing and running repository tests."
kind: "package-group"
---

# packages/test-support

English | [中文](README.zh.md)

## Summary

The test-support group gives repository tests deterministic, keyless ways to exercise the real product. It includes Loader application harnesses, session-log snapshot adapters, a replay LLM plugin, and a scriptable OpenAI-compatible fault server. Each package is support-tier infrastructure; a package moves out of this group when it gains a product contract and product consumers.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`session-snapshot`](session-snapshot/README.md) | Provides session-log snapshot support and protocol adapters for profile-driven tests |
| [`agent-loop-testkit`](agent-loop-testkit/README.md) | Provides the shared prerequisite services for tests that exercise the concrete AgentLoop |
| [`client-runtime`](client-runtime/README.md) | Provides the jsdom slot test bench for browser feature specs |
| [`remote-mock`](remote-mock/README.md) | Provides the endpoint-named Typert Remote mock and the Connection carrier face whole-client specs install |
| [`loader-smoke`](loader-smoke/README.md) | Boots Loader-composed applications and drives fixture turns for smoke tests |
| [`llm-mock-server`](llm-mock-server/README.md) | Provides a scriptable OpenAI-compatible fault server for recovery tests |
| [`llm-replay`](llm-replay/README.md) | Replays recorded model streams for keyless tests and demos |

-----

<a id="related-documentation"></a>
## Related documentation

- [Testing policy](../../docs/testing.md) — the keyless snapshot tier these harnesses serve and when it is required.
- [Runtime invariants subsystem](../../docs/subsystems/invariants.md) — registration and execution of package-owned runtime checks.
- [Package groups](../README.md) — how support groups relate to the product groups.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
