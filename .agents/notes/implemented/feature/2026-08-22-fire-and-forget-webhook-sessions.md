# Agent Note: Fire-and-forget webhook Sessions

Status: implemented

English | [中文](2026-08-22-fire-and-forget-webhook-sessions.zh.md)

## Problem

External repository events need to start ordinary DSH work without making every provider adapter understand Agent presets, Workspace attachment, titles, permissions, and callback teardown. GitHub pull requests becoming ready for review are the first use: a signed event may create a review Session that users can browse under the repository Workspace.

Turning this into a durable automation engine would introduce a second lifecycle beside Sessions: delivery records, execution states, retry and deduplication policy, crash recovery, and an answer to whether HTTP acceptance, prompt admission, Agent idle, or model output means completion. The requested capability needs none of those meanings.

## Decision

`@deepseek-ai/dsh-webhook` owns a two-operation Host runtime: rules register through `register()`, and authenticated provider adapters call `dispatch()`. Each matching callback runs independently as arbitrary trusted code and returns `null` or one Workspace-backed Session request. Dispatch returns before callbacks settle, while effect disposal aborts and drains only the calls it owns.

The runtime stores no provider delivery or execution record. It does not retry, deduplicate, resume callback work, observe Agent status, or collect a result. A repeated delivery may create another Session. `WebhookDeliveryId` remains available to a rule that deliberately implements idempotency through its own state.

## Provider adapters

Authentication belongs to provider adapters. `@deepseek-ai/dsh-webhook-github` registers one exact route on an injected WebServer, bounds the untouched UTF-8 body, resolves its secret reference per request, verifies `X-Hub-Signature-256` before parsing, and passes a signed lossless-JSON object to the runtime. `202` means only verified in-memory dispatch; it precedes rule matching, external calls, and Session creation.

The normal Web composition keeps its UI/API WebServer separate. The GitHub example mounts another WebServer and its adapter in a group that isolates only `webServer`, so a reverse proxy can expose the webhook port without exposing `/api`, WebSockets, or frontend files.

Patch loading anchors relative plugin names in inserted rows to the patch file. The same `./github-ready-review-rule.mjs` entry therefore works from a development `--patch` overlay and from a permanent profile patch without changing the rule into a package.

## Session creation

A rule result names a local Workspace path, title, text prompt, agent preset, permission preset, and optional explicit provider/model route with an output cap. Without that route, the runtime snapshots the complete live default, including reasoning effort, until the first request records its durable header. It validates presets before mutation, resolves or creates the canonical Workspace, creates the Agent with that path as Session cwd, mounts the preset before publication, and attaches the Session before admitting the prompt.

The initial follow-up is an ordinary durable user-role message whose source records the webhook provider, source, delivery, and rule identifiers. Its inbox insertion is the webhook operation's last boundary. Ordinary Session persistence and Agent lifecycle own later work; the runtime neither flushes specially nor waits for a turn.

## Alternatives considered

**Persist deliveries and execution states.** Rejected because `pending`, `admitted`, `running`, and `settled` require retry, deduplication, crash, and completion semantics that the current capability does not consume.

**Acknowledge GitHub after Session creation.** Rejected because arbitrary rules may call external systems and exceed the provider's HTTP window; a valid delivery should not couple transport availability to later rule work.

**Register the route on the main WebServer.** Rejected because operators need to expose webhook ingress without also exposing the browser API. An isolated second instance reuses the existing HTTP module without creating another server implementation.

**Restrict rules to a declarative predicate language.** Rejected because programmatic rules explicitly need arbitrary external calls. Trusted Cordis plugins already provide the required authority and lifecycle.

**Let each adapter create Sessions directly.** Rejected because Workspace, preset, permission, title, rollback, and message-source logic would spread across provider packages.

## Verification

Package tests pin independent callback execution, fire-and-forget HTTP timing, cancellation and quiescent disposal, request validation, Workspace attachment before prompt admission, rollback, GitHub HMAC and body limits, credential rotation, and exact Loader composition. The assembled Web example sends a signed ready-for-review delivery to an isolated second listener and records the resulting ordinary Workspace conversation.

A real-API e2e test starts the built `dsh web` CLI with the webhook overlay and isolated listener, synthesizes only the signed inbound GitHub delivery, observes Workspace attachment and the durable message source through the public Web API, and waits for the real DeepSeek response. No DSH service, model adapter, or provider call is replaced by a test double.

Source audits keep execution records, retry timers, dedupe maps, completion events, and Agent-status listeners absent.

## Consequences

- Provider adapters stay small and provider-specific while Session creation has one owner.
- Users receive ordinary titled Sessions under Web Workspaces rather than a second automation UI.
- HTTP success intentionally says nothing about downstream matching or Agent success.
- Crashes and repeated deliveries retain simple at-most-process-lifetime semantics; deployments needing durable automation must add a separately designed subsystem rather than reinterpret this runtime.
