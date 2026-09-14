---
description: "Open, recover and control interactive shell tabs in the Web right sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-terminal

English | [中文](README.zh.md)

## Summary

Choose an installed shell from the right sidebar's Start page to run commands in the Session workspace. Rename terminals in their tabs and recover retained processes after reloading the page. Collapse the sidebar to keep commands running; close a terminal tab to request process termination. Tab completion follows the shell configuration.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open the right sidebar and select **New terminal** on the Start page; first select **New tab** when another content tab is open. Choose an installed **Shell** and select **Start terminal**. The last selected shell is preselected from localStorage; first use or an unavailable saved choice selects the current default. Use the sidebar's **New tab** control to open more terminals.

Double-click the terminal's tab title to rename it. **Take control** makes the current attachment writable when another page owns input. A failed connection offers **Reconnect**. An exited shell remains visible with its exit code and never restarts automatically. Exited terminals count toward the Session limit; close unused tabs when the limit is reached.

Closing or replacing a terminal tab removes it immediately and ends its process in the background. A cleanup failure shows a small notification with **Retry**; retrying does not reopen the tab. Collapsing, switching tabs or Sessions, floating and fullscreen presentation preserve the process.

Displaying a Session after a page reload reopens its retained Host terminals as new tabs. A recovery failure offers **Retry terminal recovery**. A recovered process that disappears reports an error instead of starting another shell. The [sidebar layout remains memory-only](../../client/ui-sidebar-right/README.md#state).

The terminal background, default text, cursor, and selection follow the DSH theme, including system preference and theme-token overrides. Theme changes update the existing screen without clearing output or restarting the shell. Shell-provided ANSI colors remain in effect.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This plugin registers the `terminal` type and body/title seats with the right sidebar. The guide uses a compact dark terminal card, while tab titles retain the line glyph. The React-free terminal model belongs to `api-terminal-controller`; keyed framework hooks expose its state. `ui-primitives` Menu and Button provide the shell picker and startup controls, including keyboard navigation and the selected-item marker. xterm.js and FitAddon render the screen and measure the viewport. The body reserves an 8px gap below the tab strip within the pane height. Input, including Tab and control characters, travels unchanged to the PTY.

A Session header contribution queries Host terminals and opens recovery tabs. Their navigation parameters carry `terminalId` only within the current page; a recovered view cannot allocate a replacement process. The sidebar's close handler schedules cleanup through the [terminal controller](../../api/terminal-controller/README.md#understand-the-implementation) and returns synchronously. Browser component cleanup and the tab's abort signal only detach browser work.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Subprocess](../../subprocess/subprocess/README.md)
- [Right Sidebar](../../client/ui-sidebar-right/README.md)
- [Web terminal decision](../../../.agents/notes/implemented/feature/2026-09-09-web-sidebar-terminal.md)

<a id="model-experience"></a>
## Model Experience

None, as this package handles user terminal interaction without adding model input.

#### KV Cache effect

None; terminal output travels only between the browser and Host.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Shell discovery or native PTY startup can fail. The tab reports the failure without launching a different shell.
- Completion menus and inline suggestions depend on shell configuration. The Web UI adds no independent completion engine.
- Terminal history is bounded. The feature does not send terminal output to the Agent, provide split terminal panes inside a tab, or restore processes after Host restart.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published. One owner orders terminal metadata and screen updates; the provider exposes no independently observed dimensions to compare.

</details>
