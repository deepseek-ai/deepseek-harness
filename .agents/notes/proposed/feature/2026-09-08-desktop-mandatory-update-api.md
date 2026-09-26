# Agent Note: Desktop mandatory-update API

Status: proposed

English | [中文](2026-09-08-desktop-mandatory-update-api.zh.md)

## Problem

Desktop requires mandatory-update decisions when its business server is local and when the user is not signed in. Mobile ordinary-update responses do not define Desktop artifact installation. Backend and Desktop owners need a self-contained protocol with explicit success, blocking, and error semantics, separate from updater artifact selection.

## Proposal

Use a guest-accessible policy endpoint. This document owns its Desktop request and response fields; the [initial update proposal](2026-09-08-desktop-update-policy-and-installation.md) owns client scheduling, UI, release ordering, and installation. Backend integration is in progress; API origins and gateway details are deployment inputs, not evidence of a live service. No sibling repository or local document is needed to interpret this protocol.

### Endpoint and access

The [client decision](../../implemented/feature/2026-09-11-desktop-mandatory-update-client.md) owns the implemented polling and blocking UI. This API proposal remains active for backend deployment and live integration; local fixtures do not certify the service.

```http
GET /api/v0/check_client_update
```

The query itself must return the complete mandatory response; do not rely on intercepting unrelated business APIs. Preserve Android and iOS behavior without requiring existing mobile versions to send new Desktop fields. Desktop receives mandatory policy only, not ordinary-update prompts, installer metadata, updater target versions, device IDs, installation IDs, or per-installation rollout assignments.

### Request

```http
GET /api/v0/check_client_update?scenario=launch
x-client-platform: desktop-win
x-client-version: 0.1.3-rc.2
x-client-bundle-id:
x-client-locale: zh_CN
x-client-timezone-offset: 28800
x-client-arch: x64
x-client-update-channel: nightly
x-client-bundled-dsh-version: 0.1.3-rc.2
```

All listed headers are required on every Desktop request; a required header may still carry an empty value, as `x-client-bundle-id` does. The values describing installed software come from the application and its release metadata, not editable UI fields.

| Header | Meaning and allowed values |
|---|---|
| `x-client-platform` | `desktop-win` or `desktop-mac` |
| `x-client-version` | Shared client build version, inlined as `DSH_CLIENT_VERSION` at packaging; full SemVer retaining prerelease identifiers, initially equal to the bundled dsh version |
| `x-client-bundle-id` | Platform uses this field to identify the Chat application; the field does not apply to Harness, so Desktop sends it empty |
| `x-client-locale` | `zh_CN` or `en_US`, taken from the active UI language's primary subtag; selects localized content, not region |
| `x-client-timezone-offset` | Whole-second offset from UTC, positive east of Greenwich, sampled from the shell for every request |
| `x-client-arch` | Windows `x64`; macOS `x64` or `arm64` |
| `x-client-update-channel` | Initially always `nightly`, independent of version suffix |
| `x-client-bundled-dsh-version` | Full bundled dsh version from release metadata |

| Query | Client behavior | Initial backend behavior |
|---|---|---|
| `scenario` | Carry the query source; `launch` is a startup example | Ignore; final desktop enumeration does not block integration |
| `region` | Optional; send only when trustworthy region information exists | Ignore; do not infer it from UI locale |

Neither query affects initial policy matching or parameter validation. Changing or omitting either query must not change the decision for otherwise identical client conditions. Lifecycle triggers and query enum values need not have a one-to-one mapping; enumeration and analytics can be agreed before backend use is enabled.

### No mandatory update

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": null
  }
}
```

This means the current client does not require a mandatory update, not that its installed version is latest. A fresh valid response for the current client conditions may clear a known block. Desktop does not consume mobile ordinary-update payloads in this response.

### Mandatory update

```json
{
  "code": 40005,
  "msg": "Client version too low",
  "data": {
    "show_content": {
      "title": "请更新 DeepSeek Harness",
      "detail": "当前版本已停止支持，请下载并安装新版本。"
    },
    "desktop_app_link": "https://example.com/harness/download"
  }
}
```

The example URL is a placeholder, not an approved deployment destination. Desktop uses the flattened `data` fields, with no `alt_app` or `biz_data` wrapper. No Desktop has shipped, so no compatibility parser for the earlier nested proposal is required. Mobile `alt_app`, Android links, and iOS app identifiers retain their existing format.

| Field | Requirement |
|---|---|
| `code` | `40005` is the response-body code, not an HTTP status |
| `msg` | Diagnostics only, not dialog copy |
| `data.show_content.title` | Required localized plain-text title |
| `data.show_content.detail` | Required localized plain-text detail |
| `data.desktop_app_link` | Required HTTPS page matching product, platform, architecture, and channel; must satisfy the client allowlist |

Do not add `mode`, `force_update`, `show_key`, `target_version`, button copy, or updater metadata initially. `40005` determines that upgrading is mandatory; updater metadata determines the actual version and package. The client does not perform an additional mandatory-target version check from this API. Client state selects localized actions, and every download still requires user action. The page remains a fallback after in-app updater integration. The HTTP status mapping follows gateway integration and must be confirmed; the gateway must preserve the JSON body instead of replacing it with generic text or HTML.

### Errors and policy matching

Missing required headers, invalid SemVer, and unsupported platform/architecture/channel combinations return explicit parameter errors, not no-force success or a mandatory policy. Prefer the existing business meanings of `biz_code = 1` for a missing version and `biz_code = 2` for an invalid version; final error allocation belongs to the backend. Service failures must not masquerade as success because success may remove an existing block.

Match platform, architecture, Desktop version, bundled dsh version, and channel using server-owned ranges and precedence. Use complete SemVer, not lexical sorting or truncated prerelease values. Initially the two versions are equal and channel is fixed Nightly; independent revisions and channel switching are deferred. Do not require a downgrade or stop returning `40005` merely because a client has queried or displayed it before.

### Policy publication and current decisions

Every active policy requires deterministic matching conditions, localized title/detail, and a valid destination. The server evaluates current client conditions on every query. These are server configuration requirements, not extra response fields or an artifact revocation mechanism.

- Publish and verify a higher release that resolves the mandatory requirement before enabling its policy; the matching page and platform package must be available.
- For clients with in-app mandatory updating, publish the resolving version to their updater feed before activating the mandatory requirement. Release owners coordinate this ordering; the API does not supply a separate installer target, artifact eligibility response, or ordinary-update rollout.
- Match links to the product, platform, architecture, and channel; reject policy activation when content or an allowed HTTPS destination is missing.
- Return no-force success when the current client no longer matches, including after upgrading. Continue returning mandatory policy while it still matches.

Handle a defective release by publishing a higher fixed version and updating updater metadata. Do not add a revoked-version list, pre-install artifact-revocation query, or target-version validation to this API. A fresh no-force response can clear the UI block but does not select, replace, or invalidate an updater package. Artifact hash/signature checks remain required independently of the mandatory decision.

### Capacity and caching

Capacity and rate limits must account for recurring guest requests, client-side coalescing, and failure backoff. Policy delivery does not depend on chat requests or SSE. Online delivery latency depends on polling and connectivity; offline clients cannot receive new policy immediately. Prefer `Cache-Control: no-store`. A gateway must not share responses across client versions, platforms, architectures, or channels based only on URL; future caching must specify all policy/content keys and decision freshness.

## Alternatives considered

**Relying on remote business interception.** Local dsh requests need not reach the remote gateway; an independent guest query is necessary.

**Reusing the mobile nested payload for Desktop.** The backend agreement flattens Desktop fields. Preserve mobile compatibility by platform, without making new Desktop clients support an undistributed nested variant.

**Adding installation identity and ordinary-update metadata.** Initial policy needs neither per-installation rollout nor a second installer feed. Keep artifact discovery in the updater.

## Acceptance criteria

| Case | Expected result |
|---|---|
| Unauthenticated Desktop | Query works without business login |
| Windows x64, macOS x64 and arm64 | Correct platform policy and page |
| No policy match | `code = 0`, `biz_code = 0`, `biz_data = null` |
| Policy match | Top-level `40005`, direct content and page under `data` |
| Changed or omitted query parameters | Same decision for otherwise identical conditions |
| Equal prerelease Desktop/dsh versions, fixed Nightly | Full SemVer matching, no downgrade or channel-switch requirement |
| Client no longer matches, including after upgrading | No-force success; does not invalidate updater artifacts |
| Unavailable resolving release, page, or applicable feed | Policy activation rejected |
| Invalid required fields or service failure | Explicit error, not false no-force success |
| Sequential requests from different client conditions | No cross-client cache leakage |
| Existing mobile requests | Existing requirements and response structure preserved |

## Risks

Backend owners must provide test/production origins, guest gateway access, final HTTP/error-code mapping, limits, real page destinations, allowed domains, fallback locale, and policy configuration ownership. Release owners must coordinate available updater releases and mandatory-policy activation per platform. These inputs remain pending and must not be filled with developer credentials or guessed URLs.
