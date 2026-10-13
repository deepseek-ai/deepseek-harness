---
description: "Model context for users and maintainers of the Web GUI that names the DeepSeek Harness checkout and GUI URL without letting either change the system prompt."
kind: "package-reference"
---

# @deepseek-ai/dsh-harness-dev-context

English | [中文](README.zh.md)

## Summary

`dsh-harness-dev-context` tells an agent running behind the DeepSeek Harness Web GUI where the harness implementation checkout lives, how the GUI relates to "this page", and which URL serves it. The system prompt carries only value-free guidance; the current checkout path and GUI URL arrive as runtime context, so starting the process from another checkout, port, or installation never rewrites a Session's logged system prompt. Sessions whose prompt still embeds those values from earlier releases keep that text verbatim.

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

The shipped Web bundle mounts this plugin as its `harness-dev-context` row. Disable that row in a profile patch when the agent should not learn the harness checkout or GUI URL. The plugin takes no configuration and activates only where every injected service exists: `systemPrompt`, `sessionProjections`, and the `webApp` service of the Web runtime, so `--help` and non-Web compositions never mount it.

### What the model gets

Two system-prompt sections explain that the checkout differs from the working directory and that "this page" means this GUI, together with the GUI update contract. Two runtime-context lines state the current values: the installation root four directories above this package, and the Web GUI's advertised URL from `webApp.getAdvertisedUrl()`, the same value as `DSH_WEB_URL` and the startup URL. Runtime context follows the shared snapshot rules: an unchanged value adds nothing, and a changed one appends a snapshot before the step's input instead of rewriting earlier messages.

### Sessions from earlier releases

Earlier releases embedded both values in the system prompt. When a Session's latest nonempty system prompt still contains those exact paragraphs, the sections repeat them verbatim, old values included, so upgrading and later port or checkout changes leave that Session's prompt byte-identical; the runtime-context lines still give the current values. Text that only resembles an earlier paragraph receives the current guidance.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the plugin; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

A host-only session projection, `harnessDevLegacyPrompt`, folds every committed nonempty `system/message` into the earlier-format paragraphs it contains, matched by their fixed text around the value on one line. The section text providers read that state through `AssembleContext.agent`; assemblies without an agent use the current guidance. The projection is restored with every other unit when a Session resumes, so no historical event is read synchronously.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: sections, runtime contexts, earlier-format projection |

### Main flow

Activation registers the projection unit, both sections, and both contexts. At each assembly the sections choose the admitted earlier paragraph or the current guidance; at each request admission the contexts read the advertised URL. Disposing the plugin fiber removes every registration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the decision record to the services this plugin reads.

- [Process-specific values as runtime context](../../../.agents/notes/implemented/bug-fix/2026-10-11-process-specific-prompt-values-in-runtime-context.md) — why the values left the system prompt and how earlier Sessions stay stable.
- [Session projections subsystem](../../../docs/subsystems/session-projection.md) — the projection contract the earlier-format state uses.
- [Web app bundle](../../bundle/web-app/README.md) — the `webApp` service and the row that mounts this plugin.
- [Context group map](../README.md) — sibling request-context packages.

-----

<a id="model-experience"></a>
## Model Experience

### Harness checkout and Web GUI

#### What the model sees

Two system-prompt paragraphs at first-party orders 10000 and 10100, after reusable instructions, and two runtime-context lines at context orders 200 and 210. A Session admitted under an earlier release sees its own earlier paragraphs instead of the two below.

##### System-prompt paragraphs

```markdown
The runtime context names the DeepSeek Harness implementation checkout. The checkout location and current working directory are separate values and may differ; never infer the working directory from the checkout path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.

You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. The browser provides no implicit DOM, route, or screenshot context. The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while `pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. Starting another server does not update this GUI. The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.
```

##### Runtime-context lines

```markdown
Current DeepSeek Harness implementation checkout: "<installation root>".

Current DeepSeek Harness Web GUI URL: "<advertised URL>".
```

#### Token effect

Two prompt paragraphs per Session and two lines in each runtime-context snapshot. A changed checkout or URL adds one snapshot.

#### KV Cache effect

The system prompt is identical across checkouts, ports, and installations, so a process started elsewhere leaves the cached prefix intact; a changed value appends one runtime-context snapshot after it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the stability guarantee covers. They are current package constraints.

- **Two paragraphs only** — other system-prompt text that changes between releases still rewrites the first system message on routes without in-history prompt updates.
- **Earlier values stay** — an earlier-format Session keeps its old checkout path and URL in the system prompt for its whole lifetime; only the later runtime-context lines are current.
- **Mixed releases** — a release without this package rewrites the first system message of a Session started with it, so every checkout that serves a shared `DSH_HOME` needs this package before they alternate.
- **Optional values** — the two runtime-context lines are optional, so a custom persona that sets `includeRuntimeContext: false` without `complete: true` keeps the sections that point at values its requests never carry. The shipped `minimal` persona sets both.
- **Sessions without the sections** — a Session created while `surfaceContext: false` hid both paragraphs has neither in its log, so the first resumed request adds the new sections and rewrites the first system message on routes without in-history prompt updates.
- **One earlier wording** — the projection recognizes the paragraphs as the release immediately before this package rendered them; a Session holding an older wording gets the current guidance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
