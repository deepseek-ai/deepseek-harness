---
description: "The experimental group map: publicly installable pre-stable prototypes."
kind: "package-group"
---

# packages/experimental

English | [中文](README.zh.md)

## Summary

The experimental group contains prototype capabilities whose contracts can change and carry no support promise. All current packages publish under their `@deepseek-ai/dsh-experimental-*` names, including the opt-in Agent Teams composition, Auto review, Cua Driver providers, browser-use backends, cross-realm Inspector, CPython PTC backend, and browser-worker preview libraries. Released products outside this group must not depend on experimental packages. The dsh installation ships the Agent Teams, voice input, Auto review, and Schedule packages as optional bundles switched on from the Web sidebar's Plugins page ([decision](../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md)); the other packages are libraries or explicit compositions.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`speech-to-text`](speech-to-text/README.md) | Named speech recognition providers | `ctx.speechToText` |
| [`speech-to-text-sensevoice`](speech-to-text-sensevoice/README.md) | Managed local SenseVoice inference | — |
| [`api-speech-to-text`](api-speech-to-text/README.md) | Authenticated transient transcription Remote | `ctx.speechController` |
| [`client-ui-voice-input`](client-ui-voice-input/README.md) | Microphone capture and guarded draft insertion | — |
| [`voice-input-bundle`](voice-input-bundle/README.md) | Default-disabled optional voice input composition | — |
| [`agent-team-profile`](agent-team-profile/README.md) | Agent Teams collaboration, tools, and Web UI bundle | — |
| [`agent-team`](agent-team/README.md) | Named teammates with durable messages and a shared task board | `ctx.agentTeams` |
| [`client-ui-agent-team`](client-ui-agent-team/README.md) | Team roster, task board, and teammate navigation for Web | — |
| [`auto-review`](auto-review/README.md) | Explicit Web layer for same-model review before each native or PTC inner tool call | — |
| [`schedule-bundle`](schedule-bundle/README.md) | Optional Schedule, task page, and time context for the shipped Web composition | — |
| [`ptc-runtime-python`](ptc-runtime-python/README.md) | CPython subprocess backend for the PTC execution seam | `ctx.ptcRuntime` |
| [`computer-use-cua-driver-mcp`](computer-use-cua-driver-mcp/README.md) | Use an installed Cua Driver through MCP | `ctx.computerUse` |
| [`computer-use-cua-driver-native`](computer-use-cua-driver-native/README.md) | Embed the Cua Driver native npm runtime | `ctx.computerUse` |
| [`browser-use-playwright-mcp`](browser-use-playwright-mcp/README.md) | Playwright browser tools over MCP | `ctx.browserUse` |
| [`browser-use-chrome-devtools-mcp`](browser-use-chrome-devtools-mcp/README.md) | Chrome DevTools inspection and browser control over MCP | `ctx.browserUse` |
| [`browser-use-stagehand-native`](browser-use-stagehand-native/README.md) | Stagehand browser operations with explicitly configured native models | `ctx.browserUse` |
| [`browser-use-runtime`](browser-use-runtime/README.md) | Session-owned browser resources shared by experimental providers | — |
| [`inspector`](inspector/README.md) | Cross-realm CDP hub for Host debugging, Client Runtime inspection, network capture, and Cordis trees | `ctx.inspector` |
| [`tool-agent-team`](tool-agent-team/README.md) | Nine tools that let the model create, message, and coordinate teammates | registers scoped tools on `ctx.tools` |
| [`webworker-packer`](webworker-packer/README.md) | Builds the gzip-compressed VFS image consumed by the browser worker preview | library and CLI — no ctx key |
| [`webworker-runtime`](webworker-runtime/README.md) | Runs the harness plugin tree inside a dedicated browser worker | library and worker entry — no ctx key |

-----

<a id="related-documentation"></a>
## Related documentation

- [Experimental publication decision](../../.agents/notes/implemented/process/2026-09-12-experimental-publication-denylist.md) — public defaults and private exceptions.
- [Computer use](../../docs/subsystems/computer-use.md) — desktop provider choices.
- [Browser use](../../docs/subsystems/browser-use.md) — browser provider choices and Session ownership.
- [Agent Teams subsystem](../../docs/subsystems/agent-team.md) — durable Team types and the `ctx.agentTeams` service API.
- [Experimental subtree rules](AGENTS.md) — what experimental status does and does not relax.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
