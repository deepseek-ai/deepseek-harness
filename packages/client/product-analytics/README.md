---
description: "Configure Desktop product analytics, identity fields, and event timing without collecting Web usage."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-product-analytics

English | [中文](README.zh.md)

## Summary

Desktop reports selected interactions through the existing OTel product exporter by default, without a user-facing control. Ordinary Web clients never submit these events, and missing login identity is omitted.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Desktop mounts Analytics and its required Telemetry exporter. The `product-analytics` settings namespace owns the live `enabled` field, which defaults to `true`; configure it through the existing Cordis Config / settings mechanism. There is no user-facing control. Ordinary Web mounts neither service. Disabled collection reads no analytics identity and accepts no new events; the exporter remains mounted and may finish exporting records already queued. Session-feedback telemetry has its own policy.

The renderer and Electron subscribe to the Host policy through the existing authenticated stream, including reconnection. Electron also reads the initial policy before native launch reporting. Welcome obtains the current policy over IPC. The Host checks its current volatile configuration again at event intake and after identity lookup. `DSH_PRODUCT_ANALYTICS_OTLP_URL` overrides the export destination for isolated collectors. The [exporter](../../host/product-telemetry-otel/README.md) owns batching, retry, and shutdown delivery.

Common fields are `device_id`, `user_id`, `os_version`, and `app_version`. Device identity reuses the existing login record without generating one. The Host reads credential-free device, account, and OS fields through `deepseekAccount.getDeviceIdentity()`. Missing values are omitted; API keys, account tokens, prompts, and responses are never event fields.

Electron forwards its build-inlined `DSH_CLIENT_VERSION` to the Host; analytics and the exporter reuse this client version. The exporter requires it. The [Desktop composition](../../bundle/web-app/README.md) owns batching and timeout settings, including cancellation at the shutdown deadline.

The [event types](src/events.ts) own names and allowed fields. Authentication events cover the native welcome page only; workspace login after API-key entry is excluded. Views count visible page entry, including reshown native welcome windows; transient onboarding loading does not repeat the same page impression, and closing an onboarding popup reports `button_name=close`. Funded Continue uses `continue`. Message submission retains its original occurrence timestamp and captures `msg_type=default|queue|steer`, model, explicit effort, and `run_mode` before asynchronous command adjudication; only the ordinary message path reports before reference serialization, so handled and claimed commands are excluded. Later serialization, attachment, or send failures do not retract this attempt; queue execution does not count again. Attachment-only submissions follow the same rule. Plan takes precedence over an active goal. Capture and reporting failures cannot interrupt submission. Message submissions and model or effort switches omit `session_id` while the Session is blank. Model and plugin switches report only accepted changes. Fork events carry the created child ID and the source IDs, before the optional child-title update; failed creation emits nothing.

Only `plugin_toggle` carries `plugin_type`: plugin rows use `plugin`, and packages use `bundle`. Installation reports `is_success`; cancellation uses `is_success=false` and `error_reason=user_cancelled`, and an absent recovery result uses `is_success=false` and `error_reason=unknown_result`. Duration is milliseconds from the install click through the terminal result, including validation, inspection, and internal registry retries. `input_value` retains registry package identifiers and plain versions only; Git inputs become `[git]`, other URLs `[url]`, and paths or unrecognized inputs `[path-or-other]`. Both click and result use this redacted value. Reopening a hidden install dialog counts another `plugin_add_button_click`. `is_builtin` means installation-supplied (`installed=false`), not whether a profile explicitly depends on the package. Explicit build-approval retry starts a new attempt. Restart-required is success. A temporary disconnect retains the pending operation; only an absent recovery result reports `unknown_result`.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Presentational components receive callbacks. Shared Client services resolve the optional Desktop analytics sender, which requires both the native preload marker and the synchronized Host policy. The sender retains its own RPC context when called by other plugins. Native actions use the authenticated Host API; its generated Typert validator accepts only the typed event fields. The Host enriches identity immediately before queueing. It observes live compaction events without replaying Session history.

</details>

<a id="model-experience"></a>
## Model Experience

None, as analytics adds no model context or Session events.

#### KV Cache effect

None; collection does not modify model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Delivery is best effort.

- Disabling stops new collection; it does not clear the exporter queue.
- Renderer failures are discarded, and the exporter has no durable outbox or warehouse acknowledgement.
- Native startup reporting waits for Host authentication; a process that fails before Host readiness cannot report its launch.

### Dev Note

None.
