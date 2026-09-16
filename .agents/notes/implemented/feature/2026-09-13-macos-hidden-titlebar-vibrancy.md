# Agent Note: macOS hidden titlebar with vibrancy sidebar

Status: implemented

English | [中文](2026-09-13-macos-hidden-titlebar-vibrancy.zh.md)

## Problem

The desktop app drew the stock macOS titlebar: an opaque bar above the web UI that repeats chrome the page already has, spends vertical space, and keeps the sidebar from reaching the window's top edge. The window looked like a browser tab rather than a macOS application, and no mechanism existed for platform-specific presentation — every pixel was identical on macOS, Windows, and the plain web.

## Decision

The Electron main process opens the main window on darwin with `titleBarStyle: 'hiddenInset'`, `trafficLightPosition: { x: 16, y: 18 }`, `vibrancy: 'sidebar'`, `visualEffectState: 'active'`, and a transparent `backgroundColor`. `'active'` keeps the material stable behind an unfocused window; `'followWindow'` washed the sidebar out on blur.

Every web-side adjustment keys off `html[data-platform]`, which only the desktop preloads set (`document.documentElement.dataset.platform = process.platform`). The plain web and non-darwin desktop render exactly as before.

**Transparency chain.** Vibrancy shows only through transparent pixels: on darwin `html`/`body` (ui-web base.css) and the AppFrame are transparent, the center column paints `--dsw-alias-bg-base` opaque, and the sidebar column paints a translucent `color-mix` tint of the sidebar fill so the material reads through it. SidebarRoot's own opaque fill moves to the frame column for the same reason.

**Native theme sync.** The vibrancy material follows `nativeTheme.themeSource`, which otherwise tracks the OS appearance and diverges from the app's own theme preference. The ui-theme boot script and ui-layout `ThemePresenter` publish `html[data-ds-theme-source]` (`light`, `dark`, or `system`; a fixed preference, including registered theme ids, publishes its resolved scheme). The app preload observes the attribute and forwards it over `dsh-desktop:native-theme-set`; main validates the value and the sender (the main window's WebContents, including its local static Web document) and assigns `nativeTheme.themeSource`. Publishing the preference rather than the resolved scheme preserves OS-follow while the preference is `system`.

**Sidebar top strip and full hide.** On darwin the sidebar opens with a 52px top strip that clears the traffic lights, carries the collapse toggle, and is a window drag region (`-webkit-app-region: drag`; the toggle opts out). Collapsing the sidebar hides the column entirely — `computeColumns` takes an explicit `collapsedWidth` and the AppFrame passes 0 on darwin desktop — instead of the 56px rail the other platforms keep. The reopen affordances move into the conversation header: a new single, session-scoped slot `conversation.session.header.leading` sits before the breadcrumbs, and ui-sidebar registers `HeaderLeadingControls` (open sidebar + New Session, reusing the shell's inject face and locale) into it. Visibility is pure CSS against the AppFrame-published `data-sidebar-collapsed` attribute; no collapse-state pipe is added. The blank-session header keeps the leading seat mounted on darwin so a hidden sidebar always has a reopen control on screen.

**Drag regions.** The conversation title row is a drag region on darwin with every interactive descendant opted out. Electron computes drag regions from window geometry in DOM order, not stacking: an overlay covering the title band must subtract itself or the band underneath keeps taking the pointer. The right sidebar's fullscreen panel therefore sets `-webkit-app-region: no-drag` on its whole box and restores drag on its tab strips' blank runs.

**Fullscreen traffic-light clearance.** ui-dockkit publishes the tab strip's start inset as `--dsh-dockkit-strip-inline-start` (fallback the design's own 10px). The right sidebar's fullscreen presentation on darwin sets 88px on the panel body and resets 10px for every non-first split cell's subtree, so exactly the pane touching the window's top-left corner clears the lights at any split depth.

## Alternatives considered

**`titleBarStyle: 'hidden'` with custom window controls.** Rebuilding the traffic lights forfeits native behavior (hover glyphs, fullscreen transitions) for no gain; `hiddenInset` keeps them native and only asks the page to route around them.

**Keeping the 56px rail on darwin.** The rail under floating traffic lights doubled the chrome in the window's corner and wasted the width the collapse exists to reclaim; full hide with header-hosted reopen controls matches macOS sidebar conventions.

**Mirroring the resolved theme instead of the preference.** Forwarding `light`/`dark` while the user preference is `system` would freeze the window material at the value resolved at send time; forwarding `system` lets macOS keep following the OS appearance natively.

**Handling traffic-light clearance inside ui-dockkit.** The kit is host-agnostic and cannot know which host corner touches window chrome; publishing an inset variable keeps the policy in the host that owns the placement (ui-sidebar-right) and costs the kit one custom property.

**A collapse-state prop pipe into the header controls.** The AppFrame already publishes `data-sidebar-collapsed`; CSS visibility against it avoids a second state path that could disagree with the frame's transition timeline.

## Consequences

- The macOS window gains a translucent sidebar and hidden titlebar at zero cost to other platforms: every rule is scoped to `[data-platform='darwin']`, which only the Electron preload sets.
- The vibrancy material follows the app theme, including third-party registered themes (their resolved scheme). Screenshots and screen recordings differ from the flat web rendering.
- `conversation.session.header.leading` is a public slot in the client catalog; any package can occupy the seat, and ui-sidebar's occupant assumes it may render into it whenever the platform matches.
- Drag-region geometry is a window-global invariant: any future overlay that covers the title band on darwin must subtract itself with `-webkit-app-region: no-drag` or its controls become unclickable.
- The transparent window plus vibrancy is accepted to look different in screen sharing and may flash on startup; the transparent `backgroundColor` mitigates the flash.

## Testing

ui-theme boot and ui-layout presenter specs pin the `data-ds-theme-source` publication and disposal. The ui-sidebar apply spec pins the leading-seat registration (component, locale, shared inject face) and its removal on teardown. The ui-conversation skeleton spec pins the leading slot's render call in the active-phase header. The ui-theme corner-shape and full-round style gates cover the new stylesheet.
