# Agent Note: Windows desktop caption and application menus

Status: implemented

English | [中文](2026-09-16-windows-desktop-titlebar.zh.md)

## Problem

Windows needs a compact caption that keeps sidebar navigation available when the sidebar is hidden or files fill the content area. A separate Application/Edit menu consumes another row and can show a different language from the application. The shared client must preserve ordinary Web and macOS presentation.

## Decision

The Windows main window combines Electron's hidden titlebar with a native window-controls overlay. Only its local application preload publishes `data-windows-titlebar`; shared layout, sidebar, and fullscreen-panel rules require that marker. Native caption colors and context-menu language follow the application document. Renderer messages are accepted only from the primary window's main frame.

Windows removes the separate native menu row. The application preload mounts localized Application and Edit caption entries in an isolated shadow root, and the main process opens native popup menus for validated requests. Application uses the same command template as other platforms; Edit preserves the Windows native command set with explicit locale-owned labels. Existing sidebar callbacks supply caption navigation without another navigation store, and the collapsed New Session control sits between the sidebar toggle and the menus. The [macOS caption decision](2026-09-13-macos-hidden-titlebar-vibrancy.md) remains independently applicable to macOS.

## Alternatives considered

An Alt-revealed native row consumes additional vertical space and hides discovery behind a keyboard convention. Removing its commands entirely loses manual updates and editing commands. Plugin management uses the main application’s Plugins page. Caption entries preserve those operations without the extra row. Native popups retain command execution and keyboard navigation instead of duplicating editor actions in Web components.

Custom HTML window controls would make the application responsible for native caption interactions. The native overlay preserves those controls while allowing application content beside them. Global CSS changes would affect Web and macOS; the preload-owned marker restricts the presentation to the Windows main window.

## Consequences

The caption remains available above fullscreen file panels, and collapsed navigation consumes no vertical rail. Caption menus preserve application and editing commands while ordinary Web documents receive no desktop controls. Editing actions send the corresponding keys to the focused editor so its own undo history applies. Caption entries stay above content modal overlays. Keyboard activation restores the last editor and selection before dispatch; pointer activation preserves editor focus; menu completion clears the active entry. Main-process validation rejects foreign frames, unknown menu names, and invalid anchor coordinates. Native popup appearance follows the operating system.

## Testing

Desktop startup and preload tests cover platform isolation, language changes, palette messages, sender validation, native command mapping, menu lifecycle, and the absence of the Desktop Plugins shortcut. Owner-local menu and sidebar snapshots cover localized entries and expanded/collapsed controls; layout tests cover zero-width collapse. Window verification covers native popups, caption navigation, and fullscreen clearance. Ordinary-browser verification checks the absence of desktop controls and retention of its sidebar rail.
