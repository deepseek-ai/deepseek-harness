---
description: "Enable cross-Session messages and interpret acceptance receipts for independent conversations in one Harness runtime."
---

# Send a message to another Session

English | [中文](session-control.zh.md)

## Summary

Enable `session_send_message` when an Agent needs to send instructions or findings to another independent Session. The recipient can belong to a different Workspace or directory. Both Sessions must be visible to the same Harness runtime. You need a configured base-backed profile, such as `web`, and the target Session's id.

## Table of Contents

- [Enable messaging](#enable-messaging)
- [Send and check the receipt](#send-and-check-the-receipt)
- [Delivery limits](#delivery-limits)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="enable-messaging"></a>
## Enable messaging

The tool is disabled by default. Enabling it allows the calling Agent to address any independent Session visible to the runtime, including Sessions outside its current Workspace or cwd.

Append this patch to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, preserving existing entries. If `DSH_HOME` is unset, use `~/.dsh`:

```yaml
- id: tool-session-control
  disabled: false
```

Restart the profile after changing its patch. The example assumes a profile that includes the base bundle; `sdk-minimal` does not include that bundle.

From a source checkout, the same patch is available in [session-control.overlay.yml](../../apps/cli/config/examples/session-control.overlay.yml). Inspect its effect without starting the Web server:

```sh
pnpm dsh --profile web --patch apps/cli/config/examples/session-control.overlay.yml --dump-config
```

The composed `tool-session-control` row has `disabled: false`. Keep the overlay when launching that profile, or keep the patch in the profile file above. The [profile reference](../../apps/cli/README.md#profiles) explains patch precedence and configuration inspection.

<a id="send-and-check-the-receipt"></a>
## Send and check the receipt

Give the Agent the target Session id and the message to send. For example, ask it to call `session_send_message` with:

```json
{
  "session_id": "target-session-id",
  "message": "Please review the latest test results and send me your findings."
}
```

Replace the placeholder with a real independent Session id. The message must contain non-whitespace text. The recipient records the calling Agent as the sender; the tool does not accept a sender override.

A successful result contains `message_id`. It confirms inbox acceptance, without waiting for a reply or completion. A running recipient receives steering input at its next input opportunity; an idle recipient starts a turn; a cold recipient restores its conversation before accepting the message.

<a id="delivery-limits"></a>
## Delivery limits

- Archived Sessions reject messages and stay archived. Unarchive a target explicitly before messaging it.
- Subagent targets use the existing `send_message` tool and its tree-local names and permissions. `session_send_message` does not bypass subagent restoration rules.
- Cancellation stops work before acceptance; it does not retract a message already accepted. Keep a successful receipt, and do not repeat a send automatically when its outcome is unknown.
- The tool sends text and does not wait for the recipient's answer or communicate with another Harness process.

<a id="further-exploration"></a>
## Further Exploration

- [Session control tool](../../packages/session/tool-session-control/README.md) — tool arguments, result, and presentation.
- [Local Session control](../../packages/session/session-control-local/README.md) — restoration, access, and provider lifetime.

<a id="dev-note"></a>
## Dev Note

None.
