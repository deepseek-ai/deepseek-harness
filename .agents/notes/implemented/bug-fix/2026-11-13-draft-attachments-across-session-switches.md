# Agent Note: Draft attachments across Session switches

Status: implemented

English | [中文](2026-11-13-draft-attachments-across-session-switches.zh.md)

## Problem

Switching to another Session and back emptied the composer's attachment rail while its text survived (issue #5070). The Session scope disposer released every attachment the retiring composer held and revoked image previews, and nothing could rebuild them.

## Decision

**The Conversation service keeps every draft attachment across a switch.** `ConversationController` records which Session owns each draft attachment. A message the Host accepts leaves that ownership at once, while the registry keeps its attachments until the echo settles them. A retiring composer releases its attachments only when its Session was removed or a message or command was already submitted, because the Client cannot tell whether a submitted command consumed them; an aborted slash-line adjudication keeps them. Otherwise they stay registered, an active upload keeps running, a failed upload keeps its in-place retry, and the Session's next composer re-adopts them in rail order. A Session removed while no composer is mounted releases its attachments through the hub's catalog watch. Picked and dropped files hold only a browser file handle; a pasted image keeps its bytes in memory until it is sent or removed or its Session is removed.

**A reload reports discarded attachments instead of restoring them.** On `pagehide`, the input hub marks each Session that still owns draft attachments in browser storage; a back-forward cache restore clears the marks. A composer mounted with a mark and no registered attachments shows the "add them again" notice.

## Alternatives considered

**Restoring attachments after a reload from durable browser references and a Host `restore` Remote.** It would bring uploaded files and images back after a page reload, but it needs a Host Remote with its Liveshare and catalog classifications, a persisted browser format, a send gate during restoration, and an image byte payload. Desktop, where most users work, gains little: its Host binds a new port on every launch, so its storage origin, and with it every saved reference, does not survive an application restart.

**Releasing settled attachments on a switch and restoring them from the Host on return.** It would save the memory of pasted images while a Session is not shown, but every return needs a Host round trip, fails on a weak network, and allocates the same bytes again.

## Consequences

Switching never touches the Host, so a weak network cannot lose a draft attachment there. A reload or crash still discards attachments; a crash writes no mark and so shows no notice.
