# Agent Note: Computer Use consent by permission attributes

Status: implemented

English | [中文](2026-11-26-cua-permission-attributes.zh.md)

## Problem

A Windows launcher and the application that owns its windows can have different native application IDs. Feishu's Start menu entry `com.electron.Feishu` starts `Feishu\Feishu.exe`, while its window belongs to `Feishu\app\Feishu.exe` and exposes no explicit or package AUMID. Comparing one authorization ID asks the user twice for one product. Inferring relationships from publishers, directories or process ancestry groups programs that the user may intend to authorize separately. Any solution must leave native discovery, window ownership and launch waiting unchanged.

## Decision

The permission controller exposes two operations: record a user's decision for an observed application, and decide whether an observed application already has one. Both compare sets of permission attributes instead of one authorization ID. A provider reports, with each selection, its authorization ID plus optional named attribute values; the Host adds the ID itself as the reserved `cua.id` attribute and rejects native results that supply that name. The [shared matcher](../../../../packages/experimental/cua/src/application-identity.ts) treats a selection and a saved record as one permission object when any attribute of the same name has a common nonempty value. Values are compared only within their own attribute name. A successful match or saved decision adds the observed values to the record, so a later observation can match through values learned from an intermediate one even when it shares no value with the first. Records connected through shared values form one group for the permission page, **Revoke** and **Allow asking again**. Matching extends recognition only: a session grant remains session-scoped, and only an explicit **Always allow** choice saves a cross-conversation grant. A handle stays bound to the record chosen at selection; each native operation rechecks that record, not the attribute match.

macOS is the single-attribute case. Its helper reports the existing [bundle-ID or canonical executable-path digest](2026-10-25-cua-bundle-id-consent.md) and no other attributes, so its grants match exactly as before and its native code is unchanged.

Windows retains its discovery rules: a window's native ID is its explicit AUMID, then its package process AUMID, then its executable path, and only identical IDs merge. `getApp` additionally reports `windows.aumid`, the AUMIDs of the selected entry, its windows, their packages and the Shell, and `windows.executablePath`, the upper-cased executable paths of the selected windows. The selected native ID itself is always one of those values. The [package reference](../../../../packages/experimental/cua-windows/README.md#permission-attributes) owns the attribute rules. Shell values come from the undocumented Windows 8+ `IApplicationResolver`, queried on the STA thread only while building the authorization result; a failed query, or a failed second window observation, contributes no value and never fails the selection. Discovery, window ownership and launch waiting never read permission attributes.

The authorization ID keeps the Host-wide 64-hex form that `CuaApplicationId` validates on every platform: Windows hashes `windows-aumid\0` and the native ID, as it did before grants became persistable. Because the native ID is also stored as an attribute, changing that digest later would not orphan Windows grants; only renaming an attribute or changing its normalization is a durable-format change.

Application association is checked when a window is first admitted. An admitted HWND retains its association while valid. The helper does not retain target PIDs or process start times, or repeat application-identity checks before each operation. The shared helper service identity hashes only the helper executable.

Records keep their authorization keys in [profile consent storage](2026-10-19-cua-profile-consent-storage.md). [Shared application-consent enforcement](2026-09-26-cua-application-consent.md) still owns human decisions and dispatch-time checks.

## Alternatives considered

**Treat a launcher and its runtime as unrelated programs.** By executable identity they are, and repeated approval would be consistent. The product goal is one decision per application as the user perceives it; the Start menu ID and the Shell resolver supply a common value without product-specific knowledge.

**Maintain a list of product launcher and runtime layouts.** Mapping specific paths to a Start menu ID covers only listed products, depends on prior knowledge of each installer layout, and changes native discovery IDs and launch targets.

**Group by publisher, installation directory or process ancestry.** One publisher or directory can contain independent applications; launching another process does not imply consent for it.

**Combine the identifiers into one key, or require every attribute to match.** Either keeps a launcher and its runtime separate whenever one value differs.

**Use the raw native ID as the authorization key.** Functionally sufficient once attributes exist, but the 64-hex key is a Host contract shared with macOS, legacy configuration and the permission Remote; changing it would re-key existing macOS grants, which have no attributes to match through. That is a separate cross-platform decision.

**Use only documented APIs.** The window property store, package APIs and app diagnostics expose no common value for Feishu's unpackaged runtime; only the Shell resolver relates it to the Start menu ID.

**Retain PID and process-start metadata and revalidate ownership repeatedly.** This introduces a separate application-lifetime model and additional process queries for already admitted HWNDs. This implementation accepts Windows handle validity instead.

**Merge connected records into one stored record.** Existing handles and other processes refer to the original record keys; group operations preserve those keys.

## Consequences

Attributes group permissions; they do not authenticate publishers. An application declaring an authorized AUMID, or placed at an authorized executable path, shares that grant. Learned values persist after revocation, so a later decision applies to the whole group. Versions and copies sharing an attribute deliberately share consent; selections without a common attribute still require separate consent. Saved records on every platform gain an optional `attributes` field that older readers ignore.

Shared consent does not associate windows. A launcher and its runtime remain separate native application objects: a launcher handle does not operate the runtime's windows, and `app.launch()` on a launcher can still time out while waiting for a window with its own ID.

A new attribute source requires evidence that its values identify one product and must not derive from names, icons, publishers, directories or process ancestry. Tests cover matching across intermediate observations, attribute-name separation, the reserved `cua.id` name, session scope, group revocation including a group that grows during revocation, concurrent selections, restart retention, and real desktop runs showing that discovery IDs and admitted HWNDs are unchanged.
