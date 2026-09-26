---
description: "Account screens use authenticated Remote commands and a snapshot stream. The controller exposes login state without returning tokens or PKCE secrets."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-account-controller

English | [中文](README.zh.md)

## Summary

Account screens use authenticated Remote commands and a snapshot stream. The controller exposes login state without returning tokens or PKCE secrets.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The account namespace exposes getState, getProfile / getBalance, getUnnotifiedBonuses, ackBonusNotified, startSignIn, cancelSignIn, signOut, and watch. watch emits an initial complete state and subsequent complete states; disconnecting stops observation, not the login attempt. Cancellation names the attempt ID so a stale screen cannot cancel a newer login. getUnnotifiedBonuses returns null and ackBonusNotified returns false while the account is absent or has changed; failures the caller should retry arrive as thrown Remote errors.

Every operation that reaches Platform takes the calling UI's `AccountClientMetadata` — client version, active language, and UTC offset in seconds — so the Host reports the requesting UI rather than the last caller it saw. Cancellation and watch remain identity-free because they never reach Platform.

`watchExpiry` delivers live credential-expiry notifications without an initial item or replay. Desktop uses this stream to hand off a one-shot toast when switching to Welcome.

`hasRunningAccountTasks` checks running Agents through the account-owned predicate over their latest logged request context, including tools and retries. Idle Agents and API-key contexts are excluded. The account provider independently cancels matching tasks when credentials are removed.

<a id="understand-the-implementation"></a>
## Understand the implementation

The controller forwards operations to the account service and maintains no independent account state; no invariant companion is published.

<a id="further-exploration"></a>
## Further Exploration

The [credentials subsystem](../../../docs/subsystems/credentials.md) owns storage APIs; the [architecture](../../../docs/architecture.md) explains application composition.

<a id="model-experience"></a>
## Model Experience

None, as account credentials affect HTTP authentication and never enter model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A disconnected UI can recover account state through watch, but cannot resume an attempt after the Host exits. Credentials and request-token resolution are not Remote operations.

<a id="dev-note"></a>
### Dev Note

The [desktop login decision](../../../.agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.md) records cancellation and storage ownership.
