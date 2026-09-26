# Agent Note: Default DeepSeek Session-log upload

Status: implemented

English | [中文](2026-09-14-session-log-upload-default.zh.md)
## Problem

Ordinary DeepSeek requests do not contain the complete canonical Session trajectory. Requiring each installation to enable log contribution prevents the default product configuration from supplying that trajectory. Recorded-session scenarios also need stable, explicit upload policies because acceptance events are part of their expected logs.

## Decision

`session-log-deepseek.Config.enabled` defaults to `true` in every process. An explicit `enabled: false` disables the contribution. The plugin does not inspect test-runner or snapshot environment variables.

This supersedes only the opt-in default in the [request-extension decision](2026-08-21-deepseek-llm-api-request-extensions.md); that note still owns field serialization, destinations, acceptance, and retry semantics. The headless and ACP corpus base patches and Web scaffold explicitly disable upload. Later scenario patches can enable it. The SDK text-turn recording omits the setting and exercises the shipped default, including durable acceptance events.

## Alternatives considered

**Derive the production default from test environment markers.** This also changes downstream SDK behavior when callers inherit those variables and makes ordinary tests exercise a different product default.

**Refresh every recorded Session to include upload acceptance.** Explicit test composition preserves the existing scenarios while a default-configured SDK recording and Loader regression cover the default-on path.

**Retain opt-in upload.** This does not supply the complete trajectory from ordinary product requests without installation-specific configuration.

## Consequences

Eligible requests send the unaccepted canonical log suffix, up to `maxBytes` per request under the [bounded-upload decision](2026-09-24-bounded-session-log-upload.md), including message text, tool arguments and results, workspace paths, and feedback, to the resolved DeepSeek endpoint or configured gateway. No prompt tokens or model-visible content are added. Request bodies grow by up to that limit, and provider rejection still fails the request. OTel remains independent; disabling OTel does not disable this contribution.

Configuration tests cover default-on and explicit overrides with and without test environment markers. Both DeepSeek protocol Loader cases observe the default request field and recorded acceptance watermark, and explicit-off cases observe their absence. Existing headless, ACP, Web, and SDK recordings validate their declared upload policies without rewriting committed Session generations.
