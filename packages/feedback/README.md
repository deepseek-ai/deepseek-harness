---
description: "The feedback package group: user feedback on sessions and assistant messages, for users and maintainers choosing, composing, or debugging feedback capture."
kind: "package-group"
---

# feedback/ — recorded human feedback

English | [中文](README.zh.md)

## Summary

The feedback group collects human opinions about the harness's work: users can submit a free-text remark about a whole session, and rate or annotate individual assistant messages. Neither kind of feedback reaches the model — these are signals about the output, never input to it. Users record a session remark with the `/feedback` command; product surfaces read and change per-message ratings through the `messageFeedback` service. The two packages are independent: session remarks and per-message ratings do not interact. This page maps the group; the package READMEs and the [feedback subsystem page](../../docs/subsystems/feedback.md) own the per-package contracts.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`command-feedback`](command-feedback/README.md) | Session-level feedback: the `/feedback` command, the `sessionFeedback` Remote behind the Web dialog, and the fixed category taxonomy, all without a model turn |
| [`message-feedback`](message-feedback/README.md) | Per-message ratings, categories, and notes, served to product surfaces through the `messageFeedback` service |

Session remarks are a one-way signal: recording one is safe at any point in a conversation and never changes what the model sees. With a feedback-gated sharing policy, recording a session remark is what releases the session for sharing.

Per-message ratings and notes are stored with the session, survive restarts, and never appear in model history or telemetry.

<a id="related-documentation"></a>
## Related documentation

- [Feedback subsystem](../../docs/subsystems/feedback.md) — the message-feedback types, service contract, and Web consumer.
- [Session telemetry subsystem](../../docs/subsystems/session-telemetry.md) — the sharing policy disclosed by the `/feedback` acknowledgement.
- [Anonymous user identity](../identity/README.md) — the per-harness-home id embedded in the feedback acknowledgement.

<a id="dev-note"></a>
## Dev Note

None.
