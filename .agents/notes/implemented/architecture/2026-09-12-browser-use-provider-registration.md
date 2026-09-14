# Agent Note: Browser-use provider registration and Session ownership

Status: implemented

English | [中文](2026-09-12-browser-use-provider-registration.zh.md)

## Problem

Browser-control backends expose different operations and observation formats. A common browser action API would constrain those experiments before a portable consumer exists. Browser sessions can be isolated, while attaching an existing logged-in browser must preserve its state and prevent concurrent ownership inside a provider.

## Decision

[`dsh-browser-use`](../../../../packages/browser-use/browser-use/README.md) owns `ctx.browserUse`, which registers one provider-owned name and returns its effect disposer. A second registration fails regardless of its name. The service contains no browser object, shared operation type, dispatch method, resource lifecycle, or runtime selector. The [computer-use registration decision](2026-09-12-computer-use-provider-registration.md) remains the independent owner of desktop-provider registration and shared-desktop coordination.

[Playwright MCP](../../../../packages/experimental/browser-use-playwright-mcp/README.md), [Chrome DevTools MCP](../../../../packages/experimental/browser-use-chrome-devtools-mcp/README.md), and [native Stagehand](../../../../packages/experimental/browser-use-stagehand-native/README.md) own their browser tools and integrate through the normal DSH tool pipeline. They are public experimental opt-ins. DSH owns task planning and the task loop; Stagehand contributes individual AI-assisted operations. Profile or preset configuration selects launch or attachment for each provider activation.

Browser resources belong to the exact live Agent and Session, not merely a reusable Session id. Calls retain state across turns. Runtime disposal closes launched resources, and reload or fork does not inherit a launched profile. Attachment preserves existing browser state and reserves the external browser exclusively for one Session within that provider instance. Cleanup disconnects without closing the external browser.

The [experimental runtime helper](../../../../packages/experimental/browser-use-runtime/README.md) owns shared resource lifetime and attachment reservation without introducing those methods into the browser-use service. Canceling a caller's acquisition wait leaves initialization and its reservation owned by the Session. An active operation's Agent-disposal cancellation starts resource shutdown before the Agent waits for idle, because browser calls may settle only after their connections close. Provider teardown stops tool admission and retains its registration until resource cleanup and active calls settle. The service remains independent of all experimental packages.

Stagehand's launcher inherits its process environment, and SDK initialization can time out before its cleanup settles. The provider host uses `@puppeteer/browsers` to own launched Chromium and its temporary profile before CDP or SDK readiness, with a scrubbed child environment. For both launch and attachment, an isolated Worker runs the SDK and only connects over CDP. Native inference has no abort signal. SDK close waits for active work; successful cleanup permits later reconnection while retaining browser state. Failed SDK drain blocks reuse while Chromium remains alive. Final cleanup can release a launched-browser reservation after owned Chromium and its Worker terminate. Failed SDK drain during attachment, failed Worker termination, or failed owned-process cleanup retains the reservation. The host kills only its own Chromium process and waits for child closure before removing the profile; an externally owned browser remains running.

Stagehand uses an explicitly configured native model from its pinned SDK catalog. The configured API key and optional headers are forwarded into the browser extension, where Stagehand performs inference. Browser tool inputs and returned data, including SDK result metadata, use the existing Session log. DSH model routing, credential reuse, underlying inference request/response capture, and integration into Session usage accounting remain deferred; this integration adds no persistence events or Session schema changes.

MCP client activation waits for connection and tool discovery, but provider activation can finish before any Session exists. That activation promise cannot represent the clients owned by future Sessions. Each MCP browser provider awaits one client startup attempt within the existing serial `agent/created` event. The [awaited Agent creation decision](2026-09-09-awaited-agent-creation.md) owns queued-input ordering and creation rollback. Successful creation or resume exposes the completed catalog to prompt assembly and direct callers.

Startup failure or cancellation rejects creation or resume and triggers rollback of the Agent and its client resources. A busy attachment skips startup permanently for the activation while its other work continues; a newly created or resumed Agent can acquire the attachment after release. Late installation and reload apply only to future activations, following the [Schedule mounting policy](../../../../packages/schedule/schedule/README.md#use-this-package). Browser tools and resource requests for a successful client share the Session queue; other Sessions cannot execute those requests or receive that server's instructions.

## Alternatives considered

**Unified browser action API.** Playwright, Chrome DevTools, and Stagehand have different native semantics. No current consumer requires interchangeable action methods, so provider-owned tools retain those semantics.

**A provider-owned startup phase.** Existing serial `agent/created` awaits Session-owned setup and makes failures visible to the creator. A separate maintenance task would duplicate that lifecycle ownership.

**Discovery during prompt assembly.** Prompt and tool collection need ready registrations. Starting discovery there either exposes an incomplete catalog or requires another collection pass; awaited creation completes discovery before a turn begins.

**One shared browser across Sessions.** Browser tabs, navigation, and login state can be isolated per Session. Sharing them would introduce cross-Session interference that the desktop integrations cannot generally avoid.

**Fresh context when attaching.** A new browser context does not inherit the existing logged-in state. Exclusive use of the attached browser preserves the workflow that attachment enables.

**Browser profiles restored with Sessions.** Durable browser state introduces profile storage and migration ownership beyond the Session log. Launched state lasts only for the live runtime; externally owned browsers retain their own persistence policy.

**Only isolated launch.** Users need both clean browser sessions and access to existing authenticated state. Configuration selects the ownership policy explicitly.

**Delegated browser agents.** The experiments compare browser-control backends. Delegating the whole task to another planner would alter DSH's control of the task loop.

**DSH model bridge.** Native Stagehand configuration keeps its browser integration independent of DSH model-request adaptation and persistence. Session model selection, credential reuse, underlying inference capture, and Session usage accounting are deferred as one coordinated integration.

## Consequences

Providers evolve their tools independently while the shared service remains a name-only registry. The three providers and their runtime helper publish as experimental packages without enabling them in shipped defaults. The browser package group has no dependency on experimental runtime code.

Attachment reservations apply within one provider instance; they do not coordinate separate DSH processes or external browser clients. Browser state is absent from Session replay, and cancellation does not undo delivered browser actions. Provider READMEs own engine support, model requirements, and upstream restrictions.
