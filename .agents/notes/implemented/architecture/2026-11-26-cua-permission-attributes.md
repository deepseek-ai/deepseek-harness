# Agent Note: Computer Use consent by permission attributes

Status: implemented

English | [中文](2026-11-26-cua-permission-attributes.zh.md)

## Problem

A Windows launcher and the application that owns its windows can have different native application IDs. Feishu's Start menu entry `com.electron.Feishu` starts `Feishu\Feishu.exe`, while its window belongs to `Feishu\app\Feishu.exe` and exposes no explicit or package AUMID. Comparing one authorization ID repeats approval for one product. Inferring relationships from publishers, directories or process ancestry groups programs that the user may intend to authorize separately.

## Decision

Application consent compares sets of permission attributes. For each selection, a provider reports its existing authorization ID and optional named attribute values. The [shared matcher](../../../../packages/experimental/cua/src/application-identity.ts) treats a selection and a saved record as one permission object when any attribute of the same name has a common nonempty value. A successful match or saved decision adds the observed values to the record, so a later observation can match through values learned from an intermediate one even when it shares no value with the first. Records connected through shared values form one group for the permission page, revocation and **Allow asking again**. Matching extends recognition only: a session grant remains session-scoped, and only an explicit **Always allow** choice saves a cross-conversation grant.

macOS is the single-attribute case. Its helper reports the existing [bundle-ID or canonical executable-path digest](2026-10-25-cua-bundle-id-consent.md) and no other attributes, so its grants match exactly as before.

Windows retains its discovery rules: a window's native ID is its explicit AUMID, then its package process AUMID, then its executable path, and only identical IDs merge. `getApp` additionally reports AUMIDs from the selected entry, its windows, their packages and the Shell, and executable paths of the selected windows. The [package reference](../../../../packages/experimental/cua-windows/README.md#permission-attributes) owns the attribute rules. Shell values come from the undocumented Windows 8+ `IApplicationResolver`, queried on the STA thread only for consent; a failed query contributes no value. Discovery, window ownership and launch waiting never use permission attributes.

Application association is checked when a window is first admitted. An admitted HWND retains its association while valid. The helper does not retain target PIDs or process start times, or repeat application-identity checks before each operation.

Records keep their authorization keys in [profile consent storage](2026-10-19-cua-profile-consent-storage.md). [Shared application-consent enforcement](2026-09-26-cua-application-consent.md) still checks the record bound to a handle before each native operation.

## Alternatives considered

**Maintain a list of product launcher and runtime layouts.** Mapping specific paths to a Start menu ID covers only listed products, depends on prior knowledge of each installer layout, and changes native discovery IDs and launch targets.

**Group by publisher, installation directory or process ancestry.** One publisher or directory can contain independent applications; launching another process does not imply consent for it.

**Combine the identifiers into one key, or require every attribute to match.** Either keeps a launcher and its runtime separate whenever one value differs.

**Use only documented APIs.** The window property store, package APIs and app diagnostics expose no common value for Feishu's unpackaged runtime; only the Shell resolver relates it to the Start menu ID.

**Retain PID and process-start metadata and revalidate ownership repeatedly.** This introduces a separate application-lifetime model and additional process queries for already admitted HWNDs. This implementation accepts Windows handle validity instead.

**Merge connected records into one stored record.** Existing handles and other processes refer to the original record keys; group operations preserve those keys.

## Consequences

Attributes group permissions; they do not authenticate publishers. An application declaring an authorized AUMID, or placed at an authorized executable path, shares that grant. Learned values persist after revocation, so a later decision applies to the whole group. Versions and copies sharing an attribute deliberately share consent; selections without a common attribute still require separate consent.

Shared consent does not associate windows. A launcher and its runtime remain separate native application objects: a launcher handle does not operate the runtime's windows, and `app.launch()` on a launcher can still time out while waiting for a window with its own ID.

A new attribute source requires evidence that its values identify one product and must not derive from names, icons, publishers, directories or process ancestry. Tests cover matching across intermediate observations, attribute-name separation, session scope, group revocation, concurrent selections, restart retention, and real desktop runs showing that discovery IDs and admitted HWNDs are unchanged.
