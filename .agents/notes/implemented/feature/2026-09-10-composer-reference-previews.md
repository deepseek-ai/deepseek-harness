# Agent Note: Composer reference previews

Status: implemented

English | [中文](2026-09-10-composer-reference-previews.zh.md)

## Problem

Users need to inspect referenced files and skill instructions while composing a message and after sending it. File chips and editable slash tokens have different editing semantics, but both need recognizable preview gestures without changing what the next prompt sends.

## Decision

The [input-trigger source](../../../../packages/client/ui-input-trigger/README.md) owns optional reference activation. The editor routes atomic references by their source identity and editable tokens through the current source lexicon. File and skill sources open the existing right Sidebar file resource in the composing Session. Skill discovery retains the winning provider's optional instruction-file path, avoiding body loads and guesses based on skill names or directory conventions.

The [composer](../../../../packages/client/ui-conversation/README.md) shares reference hover styles while preserving atomic file chips and editable `/name` text. Clicking does not serialize or submit the draft. Invalid chips, selection gestures, and unavailable source targets retain editor handling; virtual skills remain invocable without a file preview.

Sent message bubbles retain their logged skill-invocation evidence for decoration. The [Chat target](../../../../packages/client/ui-chat/README.md) opens file paths in the viewed Session and routes loaded skill names through that Session's source. The shared user-text primitive renders these references as buttons with the existing prose file-link hover and focus style; it leaves session, directory, and command references inert.

## Alternatives considered

**Turning skill tokens into file chips** would change editing, clipboard, and prompt semantics to solve a presentation task. The existing editable token already identifies a skill through its source lexicon.

**Resolving file and skill formats inside the composer** would couple the editor to provider catalog policy and preview services. Source-owned activation keeps those dependencies with the plugins that already own reference discovery.

**Loading each skill body during discovery** would add work and provider side effects before the user requests a preview. Optional path metadata is sufficient for filesystem skills and preserves virtual providers.

## Consequences

Preview paths are transient discovery data, never added to Session messages. The skill plugin invalidates them with its existing per-Session catalog. An uncached click awaits the shared catalog fetch and retains its Session address; invalidation and disposal cancel pending previews. Filesystem providers publish resolved instruction paths while retaining discovered reload locators and resource bases. Sidebar resource readers retain responsibility for current contents, missing-file errors, and access policy. The [workspace source-file decision](2026-09-08-present-workspace-source-files.md) remains the owner of delivered-file behavior; composer previews do not supersede it.

Focused tests cover source routing, disposal, invalidation, quoted paths, selection, and unchanged draft text. The real Web composition exercises both previews, equal hover backgrounds, and deletion after opening; owner-local expected output records the skill document and a sent message. A replayed skill-invocation turn verifies both sent references after reloading history.
