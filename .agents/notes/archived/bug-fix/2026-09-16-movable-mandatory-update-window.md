# Agent Note: Movable mandatory-update window

Status: implemented
Archived: 2026-09-18

English | [中文](2026-09-16-movable-mandatory-update-window.zh.md)

## Problem

The Windows mandatory-update page used a frameless modal overlay sized to the product window. The modal disabled its parent, so the parent's native title bar could not be used to move or maximize either window. Closing the overlay was intercepted, leaving no visible exit control.

## Decision

On Windows, mandatory policy uses a separate native framed modal with move, resize, and maximize controls. The parent remains disabled while policy blocks interaction. Closing the modal requests normal application shutdown; it never dismisses policy and resumes the product window. Other platforms retain the existing overlay presentation. The [mandatory-update decision](../feature/2026-09-11-desktop-mandatory-update-client.md) still owns policy and installation authorization.

## Alternatives considered

**Keep the full-content overlay and add a drag region.** A drag region would move the disabled parent indirectly and would not restore native maximize or close controls.

**Let close dismiss the policy page.** That would expose the blocked product window without a fresh no-force policy response.

## Consequences

Windows users can place or maximize the update window and exit the application from its close button. Modal blocking and the second installation approval remain intact. Installer-owned quit disposes the modal before Electron closes windows, so its close guard cannot block installation. The native frame replaces the dimmed full-content overlay on Windows; the ordinary update dialog keeps its existing overlay.
