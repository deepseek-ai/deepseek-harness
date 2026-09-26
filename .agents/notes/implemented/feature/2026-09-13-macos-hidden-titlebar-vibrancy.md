# Agent Note: macOS hidden titlebar with vibrancy sidebar

Status: implemented

English | [中文](2026-09-13-macos-hidden-titlebar-vibrancy.zh.md)

## Problem

The desktop app drew the stock macOS titlebar: an opaque bar above the web UI that repeats chrome the page already has, spends vertical space, and keeps the sidebar from reaching the window's top edge. The window looked like a browser tab rather than a macOS application, and no mechanism existed for platform-specific presentation — every pixel was identical on macOS, Windows, and the plain web.

## Decision

The Electron main process opens the main window on darwin with `titleBarStyle: 'hiddenInset'`, `trafficLightPosition: { x: 16, y: 18 }`, `vibrancy: 'sidebar'`, `visualEffectState: 'active'`, and a transparent `backgroundColor`. `'active'` keeps the material stable behind an unfocused window; `'followWindow'` washed the sidebar out on blur.

Every macOS web-side adjustment keys off `html[data-platform='darwin']`, which only the desktop preloads set (`document.documentElement.dataset.platform = process.platform`). These rules do not apply to plain Web or other desktop platforms. The [Windows caption decision](2026-09-16-windows-desktop-titlebar.md) owns its separate presentation.

**Transparency chain.** Vibrancy shows only through transparent pixels: on darwin `html`/`body` (ui-web base.css) and the AppFrame are transparent, the center column paints `--dsw-alias-bg-base` opaque, and the sidebar column paints a translucent `color-mix` tint of the sidebar fill so the material reads through it. SidebarRoot's own opaque fill moves to the frame column for the same reason.

**Native theme sync.** The vibrancy material follows `nativeTheme.themeSource`, which otherwise tracks the OS appearance and diverges from the app's own theme preference. The ui-theme boot script and ui-layout `ThemePresenter` publish `html[data-ds-theme-source]` (`light`, `dark`, or `system`; a fixed preference, including registered theme ids, publishes its resolved scheme). The app preload observes the attribute and forwards it over `dsh-desktop:native-theme-set`; main validates the value and the sender (the main window's WebContents, including its local static Web document) and assigns `nativeTheme.themeSource`. Publishing the preference rather than the resolved scheme preserves OS-follow while the preference is `system`.

**Sidebar top strip and full hide.** On darwin the sidebar opens with a 52px top strip that clears the traffic lights and carries the collapse toggle; the strip marks itself `data-window-drag`, so its own 52px box is the window's drag region (ui-web base.css declares the one darwin drag rule) and the toggle subtracts itself through the base.css interactive rule. Collapsing the sidebar hides the column entirely — `computeColumns` takes an explicit `collapsedWidth` and the AppFrame passes 0 on darwin desktop — instead of the 56px rail the other platforms keep. The reopen affordances live in the frame's root-scoped `shell.leading` window-chrome seat, which the AppFrame mounts only while the column is fully hidden; ui-sidebar registers `HeaderLeadingControls` (open sidebar + New Session, reusing the shell's inject face and locale) into it. The seat placement, the `--dsh-frame-leading-clearance` variable panels pad by, and the removal of the earlier conversation-header seat are owned by the [shell.leading Agent Note](../architecture/2026-09-17-frame-shell-leading-window-chrome-seat.md).

**Window fullscreen marker.** macOS fullscreen hides the traffic lights, so layouts built around them must relax. The main process relays `isFullScreen()` over `dsh-desktop:window-fullscreen` on `enter-full-screen`, `leave-full-screen`, and each `did-finish-load`; the app preload's `syncWindowFullscreen()` mirrors it onto `html[data-fullscreen]`. Consumers: the AppFrame drops `--dsh-frame-leading-clearance` to 84px and moves the seat to `left: 12px`, the sidebar's `.topStrip` moves the toggle to the strip's left edge, and the right sidebar's fullscreen panel resets its first pane's dockkit strip inset to the ordinary 10px.

**Drag regions.** Electron computes drag regions from window geometry in DOM order, not stacking, so the shell declares `-webkit-app-region: drag` once, over the mark a chrome row puts on its own box, each row's box being its draggable geometry. The ui-theme app-region gate's `CHROME_ROWS` manifest is the list of rows that must carry the mark, so this note keeps only the mechanism. The frame declares none — the Windows caption row is that platform's own chrome — so no fixed band has to match any row's height. Everything interactive subtracts itself through two global ui-web base.css rules: one `:is(...)` selector opting out every interactive element (buttons, links, inputs, roles, `[tabindex]`), and one `body > :not(#root)` rule covering every overlay portaled beside `#root`. The ordering rule those two rest on: a surface that covers the window and must stay clickable portals beside `#root` (the settings overlay does), which puts it after every drag row in document order; content containers never declare drag, which would override earlier-mounted overlays. The [coverage contract note](../architecture/2026-09-19-window-drag-coverage-contract.md) owns the manifest, the browser lane, and the manual state matrix.

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
- The reopen controls occupy the frame's `shell.leading` seat, a public slot in the client catalog; the earlier `conversation.session.header.leading` seat is removed ([shell.leading Agent Note](../architecture/2026-09-17-frame-shell-leading-window-chrome-seat.md)).
- Drag-region ownership is a window-global invariant: `-webkit-app-region: drag` appears only in ui-web `base.css` (the one darwin rule over `data-window-drag`) and in ui-layout `AppFrame.module.css` (the Windows caption `.frame::before`); other packages rely on the base.css opt-outs or add a scoped `no-drag`, never a new drag surface. The ui-theme app-region gate pairs each chrome row's markup mark with its sheet, selector, and authored height, and refuses a mark anywhere else.
- The transparent window plus vibrancy is accepted to look different in screen sharing and may flash on startup; the transparent `backgroundColor` mitigates the flash.

## Testing

ui-theme boot and ui-layout presenter specs pin the `data-ds-theme-source` publication and disposal. The ui-sidebar apply spec pins the `shell.leading` registration (component, locale, shared inject face) and its removal on teardown; the ui-layout app-frame spec pins the seat's darwin mount. The desktop main-startup spec pins the fullscreen relay (transitions, reloads, destroyed-window guard, darwin-only registration) and the preload-platform spec pins the `html[data-fullscreen]` mirror. The ui-theme corner-shape and full-round style gates cover the new stylesheet, and its app-region gate pins the one darwin drag rule and every chrome row's markup mark.
