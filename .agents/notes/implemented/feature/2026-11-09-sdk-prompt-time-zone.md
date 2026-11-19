# Agent Note: Per-prompt SDK time zone

Status: implemented

English | [中文](2026-11-09-sdk-prompt-time-zone.zh.md)

## Problem

Web and Desktop prompts carry the browser zone that the Host canonicalizes and records on that user message, and [time-context](../../../../packages/context/time-context/README.md) tells the model to interpret unqualified dates and times in it. SDK prompts recorded `{ kind: 'user' }`, and time-context read a zone only from a user source that also had a Web `rpcId`. Every SDK request therefore showed `Browser time zone for this request: unavailable.`, and the model asked about dates that a Web user would never be asked about. The SDK protocol had no field through which an embedding application could report its user's zone.

## Decision

The zone stays request-local message source data, as in the [explicit Schedule time-zone decision](../simplification/2026-08-09-explicit-schedule-time-zone.md); the SDK supplies it per prompt.

- `session/prompt` and `session/query` accept an optional `timeZone`. The TypeScript client accepts it in `HarnessClient.prompt()` options and `run()` options; the Python client accepts the `time_zone` keyword in `session_prompt()` and `run()`.
- The SDK server canonicalizes an explicit value with `canonicalClientTimeZone`, the check the Web Host uses. A rejected value fails that request with a `TypeError`, answered as JSON-RPC `-32603` like the server's other parameter errors, before a Session is created or input is routed.
- An omitted value samples `Intl.DateTimeFormat().resolvedOptions().timeZone` when each prompt is accepted. A sampled value that does not canonicalize, such as `+00:00` under `TZ=GMT` or `Etc/Unknown`, records no zone and does not fail the prompt.
- The prompt records the `sdk-user` message source `{ kind: 'user', clientTimeZone? }` without `rpcId`. The `rpcId` identifies a Web submission for prompt acknowledgement and attachment reclamation, which the SDK does not have.
- `reportedBrowserTimeZone` reads a string `clientTimeZone` from any `user` source. Writers canonicalize before commit, and request preparation still refuses a noncanonical value, so the Web path and the model-visible text stay unchanged.
- Native commands record no zone. Web executes slash commands through `commands.execute` without `clientTimeZone`, and SDK `session/query` routes commands to the same handlers, so `/plan <text>` steers a zone-less message on both paths.

## Alternatives considered

**Inject one runtime-wide zone into every request.** A process or configuration zone applied by time-context would also cover in-process children and plugin messages, but it would present a deployment fact as user authority. The time-context fallback display zone already exists and deliberately keeps the `unavailable` policy.

**Write a synthetic `rpcId` on SDK prompts.** This reuses the Web source variant unchanged, but Web clients use `rpcId` to settle submissions and reclaim attachments, so a synthetic identity would claim a Web submission that never existed.

**Fix the zone at `initialize`.** One value per connection saves a field per prompt, but a long-lived runtime can serve users in different zones and a process zone can change, so the value would become stale. A per-prompt value matches the Web browser sample.

## Consequences

- SDK embeddings that pass no zone now report the runtime process zone. In a container this is usually `UTC`, which may differ from the user's zone; the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.5/sdk-prompt-time-zone/guide.md) tells consumers to pass `timeZone` or `time_zone`, or to set `TZ`.
- SDK subagent children receive prompts without a zone, so they report their own process zone; in-process children see `unavailable`, as on Web.
- A reader that predates the relaxed check ignores an SDK prompt zone; the [persistence record](../../../../docs/persistence-changes/2026-11-09-sdk-prompt-time-zone.md) keeps the format version.
- `packages/sdk/server/tests/time-zone.spec.ts` pins canonical, rejected, sampled, and unusable zones, the `session/query` route, and matching `/plan` sources on the SDK and native command paths. `apps/cli/tests/profiles/sdk/keyless-smoke.e2e.ts` asserts the model-visible line through the shipped `sdk` profile. The SDK snapshot driver sends `timeZone: 'UTC'` and runs with `TZ=UTC`.
