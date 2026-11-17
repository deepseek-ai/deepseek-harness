# Agent Note: Draft attachments across Session switches

Status: implemented

English | [中文](2026-11-13-draft-attachments-across-session-switches.zh.md)

## Problem

Switching to another Session and back emptied the composer's attachment rail while its text survived (issue #5070). The Session scope disposer released every attachment the retiring composer held and revoked image previews, and nothing could rebuild them.

## Decision

**A draft with attachments holds its Session's scope.** While a composer draft has attachments and its Session is not removed, the input hub holds the Session with a `draft` reference that keeps no event connection, as [Session retain facets and recently viewed Sessions](../architecture/2026-11-15-session-retain-facets-and-recent-views.md) defines. Switching away and evicting the Session from the recent views therefore keep the same composer shell and its attachments: an active upload keeps running, a failed upload keeps its in-place retry, and a pasted image keeps its bytes in memory. Removing the last attachment, sending it, or removing the Session releases the hold; scope teardown then releases every attachment the draft still holds.

**A reload reports discarded attachments instead of restoring them.** On `pagehide`, the input hub marks each Session whose draft holds attachments in browser storage; a back-forward cache restore clears the marks. A composer mounted with a mark shows the "add them again" notice.

## Alternatives considered

**Restoring attachments after a reload from durable browser references and a Host `restore` Remote.** It would bring uploaded files and images back after a page reload, but it needs a Host Remote with its Liveshare and catalog classifications, a persisted browser format, a send gate during restoration, and an image byte payload. Desktop, where most users work, gains little: its Host binds a new port on every launch, so its storage origin, and with it every saved reference, does not survive an application restart.

**Recording draft-attachment owners in the Conversation service and re-adopting them in the next composer.** It keeps attachments without holding the scope, but it tracks Session lifetime a second time through a catalog watch and splits submission release across composer phases; holding the scope keeps the composer itself.

**Releasing settled attachments on a switch and restoring them from the Host on return.** It would save the memory of pasted images while a Session is not shown, but every return needs a Host round trip, fails on a weak network, and allocates the same bytes again.

## Consequences

Switching never touches the Host, so a weak network cannot lose a draft attachment there. A reload or crash still discards attachments; a crash writes no mark and so shows no notice.
