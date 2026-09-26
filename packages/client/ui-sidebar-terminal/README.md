---
description: "Open, recover and control interactive shell tabs in the Web right sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-terminal

English | [中文](README.zh.md)

## Summary

Choose an installed shell from the right sidebar's Start page to run commands in the Session workspace. Rename terminals in their tabs and recover retained processes after reloading the page. Collapse the sidebar to keep commands running; close a terminal tab to request process termination. Tab completion follows the shell configuration. Commands use the execution environment’s system-user permissions independently of Agent permissions; see [user-terminal execution](../../api/terminal-controller/README.md#use-this-package).

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

The `terminal.new` command creates a separate terminal in the focused dock pane, replacing a guide and retaining existing content pages. From the conversation or a floating content page, it uses the active dock pane. The guide card right-aligns the current effective shortcut as unboxed text without a duplicate tooltip. Windows and macOS Web use the [shortcut service’s platform defaults](../shortcuts/README.md); Linux Web leaves the command unbound by default.

Open the right sidebar and click **New terminal** to open the remembered available shell immediately. The separate arrow beside the title opens the installed-shell menu; selecting an item remembers it and opens that shell directly. Discovery runs when the menu opens and does not allocate a terminal. A failed lookup offers Retry in the menu. Use **New tab** to return to the guide and open another terminal.

Double-click the terminal's tab title to rename it. **Take control** makes the current attachment writable when another page owns input. A temporary disconnect preserves the screen and offers **Reconnect**, without exposing transport diagnostics. An exited shell remains visible with its exit code and offers **New terminal**; it never restarts automatically. Exited terminals count toward the Session limit; close unused tabs when the limit is reached.

Closing or replacing a terminal tab removes it immediately and ends its process in the background. Cleanup failures have no notification or manual retry action; saved unfinished close requests are retried when the Client plugin starts. Collapsing, switching tabs or Sessions, floating and fullscreen presentation preserve the process.

After reload, the [sidebar restores its layout](../../client/ui-sidebar-right/README.md#state) and each terminal reconnects to its saved Host identity in the original tab. Collapsed and inactive tabs do not create recovery duplicates or change selection. Host terminals absent from the saved layout do not reopen automatically and have no UI recovery entry; they remain subject to the controller's unattended idle reclamation and Session/Host disposal. A missing saved process shows a localized unavailable panel with **New terminal**. Clicking it replaces the unavailable tab in place with a fresh terminal; recovery never creates that replacement automatically.

The terminal background, default text, cursor, and selection follow the DSH theme, including system preference and theme-token overrides. Theme changes preserve the running shell, output, and application OSC color overrides. Reset commands restore colors to the current DSH defaults. xterm adjusts text toward 4.5:1 contrast; the cursor keeps at least 3:1 contrast against its cell background, including Vim colorschemes.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This plugin registers the `terminal` type and body/title seats with the right sidebar. The guide reuses the Plugins page’s blue terminal artwork; tab titles use the line glyph. The React-free terminal model belongs to `api-terminal-controller`; keyed framework hooks expose its state. `ui-primitives` Menu and Button provide the shell picker and startup controls, including keyboard navigation and the selected-item marker. The body loads its package-local `client.terminal.js` chunk when a terminal view mounts, keeping xterm.js and FitAddon out of the startup `client.js`; they then render the screen and measure the viewport. The body reserves an 8px gap below the tab strip within the pane height. Input, including Tab and control characters, travels unchanged to the PTY.

The terminal controller saves each globally unique content identity's Host association independently and owns content recovery; the sidebar owns layout persistence. A recovered view cannot allocate a replacement process. The sidebar's close handler schedules cleanup through the [terminal controller](../../api/terminal-controller/README.md#understand-the-implementation) and returns synchronously. Browser component cleanup and the tab's abort signal only detach browser work.

At plugin startup, terminal-kind entries in the sidebar's complete open-tab inventory retain matching saved Host identities, including dormant Sessions. This window hold remains independent of React mounts and screen subscriptions. Removing the last matching occurrence releases it; collapsing or switching views does not. The [terminal controller](../../api/terminal-controller/README.md#use-this-package) owns unattended idle reclamation and long-command protection.

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
- Application OSC color overrides are retained by the mounted renderer; a newly opened renderer cannot recover them from the Host screen snapshot.
- Terminal history is bounded. The feature does not send terminal output to the Agent, provide split terminal panes inside a tab, or restore processes after Host restart.
- A failed terminal chunk load requires a page reload because React caches a rejected lazy import for the page lifetime.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published. One owner orders terminal metadata and screen updates; the provider exposes no independently observed dimensions to compare.

</details>
