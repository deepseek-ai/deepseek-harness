# Agent Note: Web install icons and launch display

Status: implemented

English | [中文](2026-10-13-web-install-icons-and-launch-display.zh.md)

## Problem

A launcher masks the icon it puts on the home screen and chooses that icon itself. The install manifest advertised the whale favicon: an SVG mark drawn edge to edge on a transparent canvas, with no tile and no background of its own. Handed to a mask, the mark loses its fins and fills the tile at the wrong proportion. iOS reads no manifest icon at all and had no `apple-touch-icon` to fall back on, so an installed web app showed a generic tile. The manifest also requested `display: "fullscreen"`, which removes both system bars on Android and leaves a chat surface with no clock, battery, or navigation.

## Decision

`apps/web/public/` carries four install icons: a 192px and a 512px `any` raster, a 512px `maskable` raster, and a 180px `apple-touch-icon`. [`render-app-icons.ts`](../../../../apps/web/scripts/render-app-icons.ts) renders all four from the official application tile in `apps/desktop/resources/icon.svg`, and `pnpm --filter @deepseek-ai/dsh-web-frontend run render:app-icons` regenerates the committed files. Each variant preserves the whale's geometry, gradients, opacity, and filters. Rendering first produces a bitmap at no less than the 1024px source extent and four times the output edge, then reduces it with Lanczos3. This separate rasterization retains the original shading while smoothing the small icon's curves. Every variant crops the tile's desktop drop shadow. The maskable variant scales the whale about the tile centre by `MASKABLE_ARTWORK_SCALE` while the tile's gradient keeps its own extent, so the border a mask may crop is still the real tile rather than a flat colour meeting it at a seam.

[`pwa-manifest.e2e.ts`](../../../../apps/web/tests/pwa-manifest.e2e.ts) uses the browser image decoder to measure the committed maskable whale’s ink radius and rejects artwork outside the platform safe zone or smaller than the intended scale. The unscaled tile exceeds that zone and serves as the negative control.

The manifest requests `display: "standalone"`, names `#ffffff` as its `theme_color` and `background_color`, and lists the three rasters. `apps/web/index.html` adds the `apple-touch-icon` link, `mobile-web-app-capable`, and `apple-mobile-web-app-title`. It adds no `theme-color`: `ThemePresenter` owns the single such node and follows the resolved in-application theme, which a static media query cannot. The tab favicons are unchanged.

This supersedes the icon entry and the display mode in the [archived Web install manifest note](../../archived/feature/2026-08-06-web-install-manifest.md); its link to the manifest, product name, compact name, and root identity remain current.

## Alternatives considered

**Keep `favicon.svg` as the only icon.** It leaves iOS, which reads no manifest icon, with a generic tile, and the mark already reaches its own edges, so a launcher's mask crops it. `pwa-manifest.e2e.ts` keeps the unscaled tile’s overflow as its browser-pixel negative control.

**Commit the rasters without a generator.** The tile artwork moves with the desktop application's icon. A hand-exported set drifts silently and records neither the crop nor the safe-zone scale that makes it installable.

**Draw a separate browser mark.** The product has one approved tile. A second mark would need designer approval and would not match the installed desktop application beside it.

**Keep `display: "fullscreen"`.** Hiding both system bars suits an immersive surface, not a conversation the user reads beside the clock and returns to from the app switcher; `fullscreen` also offers no way back to the bars without a swipe.

**Ship a service worker for offline start.** Installation, launch, and reconnect work without one. Offline use is a separate capability with its own cache-invalidation contract, and no current requirement asks for it.

## Consequences

The repository carries four committed rasters, all rendered by one script from `apps/desktop/resources/icon.svg`. Changing the desktop tile means rerunning that script and reviewing the PNG diff. Unit tests inspect committed PNG dimensions without loading the native renderer. Browser tests execute the generator and decode its output and all four built PNGs, checking declared edges, opaque corners, and artwork extents against the source tile with a two-pixel rasterization tolerance. Maskable checks bound its artwork above and below, with the unscaled tile as the safe-zone negative control. Tests also compare fractional coverage along the Apple icon’s curves against direct small-size SVG rendering, which retains the source’s hard pixel edges.

The manifest's `theme_color` is one value and cannot follow the in-application theme, so a user whose theme differs from the system scheme sees that value until `ThemePresenter` writes the synchronized node shortly after boot. The presenter stays the only owner of `meta[name="theme-color"]`: a second static node wins document order and desynchronizes surrounding browser chrome from the rendered palette, which `settings-chrome.e2e.ts` pins.

iOS ignores `background_color` and masks the touch icon with its own rounded rectangle; the tile's own margins keep the whale clear of that mask. Android selects the maskable raster for the home screen and an `any` raster for the install surface. The install icons are not a service worker: an installed Web App still needs the Host reachable.

Real-device installation, launch display, and window mode remain a device check.
