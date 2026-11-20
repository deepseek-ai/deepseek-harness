---
description: "Enable cross-Session messages in a Web profile and interpret acceptance receipts for independent conversations."
---

# Send a message to another Session

English | [中文](session-control.zh.md)

## Summary

Enable `session_send_message` in a Web profile when an Agent needs to send instructions or findings to another ordinary Session. The recipient can belong to a different Workspace or directory. You need a profile that includes the `@deepseek-ai/dsh-web-app` bundle, such as `web`, and the target Session's id. The tool is unavailable in the `headless`, `sdk`, `sdk-minimal`, and `acp` profiles.

## Table of Contents

- [Enable messaging](#enable-messaging)
- [Send and check the receipt](#send-and-check-the-receipt)
- [Delivery limits](#delivery-limits)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="enable-messaging"></a>
## Enable messaging

The tool is disabled by default. Enabling it allows any Agent that sees it, including a subagent, to address any ordinary Session that the Web Session controller can open, including Sessions outside its current Workspace or cwd.

Append this patch to `$DSH_HOME/profiles/<profile>/cordis.patch.yml` of a Web profile, preserving existing entries. If `DSH_HOME` is unset, use `~/.dsh`:

```yaml
- id: tool-session-control
  disabled: false
```

Restart the profile after changing its patch. The patch targets the `tool-session-control` row of the Web bundle. The `headless`, `sdk`, `sdk-minimal`, and `acp` profiles have no such row, so the Loader warns that the entry is not found and skips the patch there.

From a source checkout, the same patch is available in [session-control.overlay.yml](../../apps/cli/config/examples/session-control.overlay.yml). Inspect its effect without starting the Web server:

```sh
pnpm dsh --profile web --patch apps/cli/config/examples/session-control.overlay.yml --dump-config
```

The composed `tool-session-control` row has `disabled: false`. Keep the overlay when launching that profile, or keep the patch in the profile file above. The [profile reference](../../apps/cli/README.md#profiles) explains patch precedence and configuration inspection.

<a id="send-and-check-the-receipt"></a>
## Send and check the receipt

The tool description instructs the Agent to send only when you explicitly ask it to message another Session. Give it the target Session id and the message to send. For example, ask it to call `session_send_message` with:

```json
{
  "session_id": "target-session-id",
  "message": "Please review the latest test results and send me your findings."
}
```

Replace the placeholder with a real Session id other than the caller's own. The message must contain non-whitespace text. The recipient records the calling Session as the sender; the tool does not accept a sender override.

A successful result contains `message_id`. It confirms inbox insertion, without waiting for a reply or completion. Target cancellation or disposal can leave the message unprocessed. A running recipient receives steering input at its next input opportunity; an idle recipient starts a turn; an inactive recipient resumes its conversation before accepting the message and then stays loaded, like a Session opened in the Web UI.

<a id="delivery-limits"></a>
## Delivery limits

- Archived Sessions reject messages and stay archived. Unarchive a target explicitly before messaging it.
- Subagent targets are unavailable to `session_send_message`, so an ordinary Session cannot use it to reply to a subagent sender. Use `send_message` only for members of the caller's own subagent tree.
- Automatic replies can repeatedly wake two Sessions and consume tokens. The explicit-user-request instruction relies on the model; the runtime applies no message-rate or hop limit.
- Cancellation before acceptance prevents delivery. After acceptance, cancellation can return `ABORTED` without retracting the message. Do not repeat a send automatically after cancellation or another unknown outcome.
- The tool sends text only. It does not wait for the recipient's answer or communicate with another Harness process.

<a id="further-exploration"></a>
## Further Exploration

- [Session control tool](../../packages/session/tool-session-control/README.md) — tool arguments, failures, and presentation.
- [API Session Controller](../../packages/api/session-controller/README.md) — Session activation and restoration in Web profiles.

<a id="dev-note"></a>
## Dev Note

None.
