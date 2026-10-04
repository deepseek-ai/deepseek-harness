---
description: "Control Session-log upload with DeepSeek API requests from General settings."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-session-log

English | [中文](README.zh.md)

## Summary

Use **Upload Session Log when using the official model API** above the version number in **Settings → General** to control Session-log upload with DeepSeek API requests. The switch shows the accepted Host setting and saves each change immediately. It appears only while the Host exposes the upload setting; read-only clients cannot change it.

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

The Web bundle mounts this companion. Its switch edits the Host plugin's `enabled` field through the shared configuration form. A save failure keeps the accepted value and shows a toast that survives closing Settings. See [Session-log upload](../../session/session-log-deepseek/README.md#configuration) for request timing, resumed uploads, and the separate OpenTelemetry setting.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The companion contributes a `settings.general.item` row while `session-log-deepseek` is served and a `shell.overlay` toast for mutation outcomes. The shared form owns persistence and reconnect synchronization; the companion owns only pending-write state and localized notices.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Settings forms](../ui-settings/README.md) — accepted Host values and ordered writes.
- [Session-log upload](../../session/session-log-deepseek/README.md) — request contribution and acceptance tracking.
- [Web Client](../../../docs/subsystems/web-client.md) — plugin composition and settings placement.

<a id="model-experience"></a>
## Model Experience

None, as this browser preference contributes no model-visible content.

#### KV Cache effect

None; the setting controls request metadata outside model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The row is unavailable when the Host does not expose the `session-log-deepseek` namespace.

<a id="dev-note"></a>
### Dev Note

None.
