# Agent Note: Live subagent model-selection setting

Status: implemented

English | [中文](2026-11-17-live-subagent-model-selection-setting.zh.md)

## Problem

[User-authorized subagent model routes](2026-08-24-user-authorized-subagent-model-routes.md) snapshotted the Host allowlist into each fresh top-level Session as `subagent/model-selection-policy`. A user who enabled the setting, added a route, or revoked one in the middle of a Session saw no effect until a new Session started; restored Sessions kept whatever list their creation recorded. The setting's observable meaning depended on when each Session was created, which the settings page could not explain.

## Decision

`SubagentModelSelectionConfig.allowedRoutes()` reads the volatile `enabled` value at each call and returns `undefined` immediately when selection is disabled; otherwise it validates `allowedModels` and returns a detached route list. The `subagent` executor and `list_subagent_models` call it through `ctx.get('subagentModelSelection')` for explicit route selection by model-selectable tools and for every discovery call, so an edit applies to the next call in every running, restored, and child Session. When the service is absent or the setting is disabled, explicit selection permits only the current parent route, as before.

No Session event is appended and no projection is registered. The `subagent/model-selection-policy` declaration remains so released Session logs still validate, but no code reads it; a Session that recorded a policy follows the current setting. An enabled setting with an empty, malformed, or repeated route list fails each call that reads it with `INVALID_MODEL_SELECTION_SETTINGS` rather than rejecting Agent creation. Ordinary delegation and tools with model selection disabled do not read the list.

## Alternatives considered

**Keep the creation-time snapshot.** Rejected because the user-visible setting is a standing authorization, and an edit that silently skips every open Session reads as a broken control. The earlier note's concern that an edit changes a running Session's capabilities is the requested behavior.

**Record a new policy event whenever the setting changes.** Rejected because it would append to every live Session on each settings save, still miss restored Sessions until they load, and leave two sources that could disagree. The allowlist is not model-visible input: the tool schemas are fixed, and only a `list_subagent_models` result or a delegation error reaches the model, and both are logged as tool results.

**Honor a recorded policy when present and fall back to the setting.** Rejected because an old Session would then ignore later edits, recreating the inconsistency for exactly the Sessions users resume most.

## Consequences

- Revoking a route takes effect at the next call, including for children of a running parent; a route that was allowed earlier in the transcript can now be rejected with `MODEL_ROUTE_NOT_ALLOWED`.
- Replaying a Session no longer reproduces its authorization from the log alone; the tool results in the log still show what the model saw.
- Agent creation no longer depends on the setting service, so an invalid setting cannot block Sessions without delegation tools.
- Unit tests in `packages/subagent/tool-subagent/tests/model-selection-settings.spec.ts` pin live reads, mid-Session edits in parent and child Sessions, and that a recorded policy is ignored.
