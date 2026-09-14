# Agent Note: Command identities and composer-owned File action

Status: implemented

English | [中文](2026-09-10-command-identities-and-composer-file-action.zh.md)

## Problem

Matching a command's English description to a client dictionary makes punctuation changes affect localization and inserted command tokens. A same-name override can also copy that description without implementing the first-party command. The File menu entry needs the composer's live attachment policy, including mount, lock, and submission state; a separate command-plugin check cannot determine that state.

## Decision

The command registry preserves an optional branded `CommandDefinitionId` as `definitionId` on the effective definition and descriptor. First-party producers choose their package name as the stable identity. Scoped shadowing selects the complete descriptor and never inherits the shadowed definition's identity. The identifier is discovery metadata, not an authorization claim, and does not enter command lifecycle events.

The client command directory resolves input through its private `resolution.ts`. Exact registered names take priority; Chinese and English aliases select only the corresponding first-party definition in the effective Session catalog. Menu claims use the current locale's spelling; typed claims retain the supplied spelling; submissions use the resolved registered name. `presentation.ts` owns only sections, labels, descriptions, and icons. Resolution helpers and section constants are not exported from the plugin entrypoint.

Conversation registers the File action through the injected command service and owns its localized label. The mounted input binds its file-dialog opener and one live availability query. Both menu filtering and invocation use that query, so lock, unmount, subagent, and submission state apply consistently. The binding and dispatch remain package-internal callbacks; no cross-plugin pick-files event is needed. The assembly uses a narrow structural action-registration face because command UI consumes Conversation's input types; a reverse compiler-project dependency would form a cycle. Its registration test checks against the command plugin's contribution type.

This note supersedes only identity matching, input-resolution placement, and File-action ownership in the [composer menu decision](../feature/2026-09-08-composer-menu-sections-and-localized-rows.md). That note retains the menu, scrolling, claim-retention, and composition-timing decisions.

## Alternatives considered

**Match names and English descriptions.** Copy is editable and can be duplicated by unrelated definitions. A stable identity separates presentation selection from copy without moving localized text onto the Host.

**Match names alone.** An agent-scoped override may deliberately provide a different command under the same name. It must not inherit first-party presentation or aliases unless it explicitly carries that identity.

**Keep the File action in the command plugin.** The input owns attachment acceptance and the DOM lifetime. Maintaining a second availability condition splits one policy between owners.

**Export helpers for reuse.** No production consumer needs the section constants or resolution helper as a plugin API. Tests import internal modules directly.

## Consequences

First-party producers and client identity mappings must agree on stable identifiers; third-party definitions may omit them. Display copy can evolve independently. Registry tests cover descriptor preservation and shadowing; client tests cover description edits in both locales, alias resolution, and exact-name priority. Composer tests cover live availability, opener replacement, unmount, and action-registration disposal. The existing Session-driven menu and command scenarios continue to own assembled browser output.
