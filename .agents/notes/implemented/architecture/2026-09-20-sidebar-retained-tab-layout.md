# Agent Note: Stable Sidebar tab mounting and Session retention

Status: implemented

English | [中文](2026-09-20-sidebar-retained-tab-layout.zh.md)

## Problem

Restoring Session-specific tab records and URLs does not preserve a live browsing context. Unmounting a body or changing its DOM ancestors during tab, pane or Session transitions disconnects its page. Electron 44's `WebViewElement.disconnectedCallback` detaches and resets its guest, so preserving a React key or caching an element reference cannot compensate for disconnected ancestors. Content size, clipping and overlap must also follow the actual parent layout.

## Decision

Sidebar owns live-body retention, independently of Browser navigation and Workspace storage. A retained page's DOM ancestors remain connected and unchanged during Session switches, tab selection, pane moves, collapse, floating and docking back. Browser Presentation attaches directly inside its content container and performs no placeholder measurement or overlay positioning.

### Layout ownership

- `DockLayout` renders the Sidebar's one or two horizontal panes with stable tab siblings. The existing recursive `DockSurface` and separate `FloatLayer` remain available for general split-tree rendering; the layout engine and serialized format are unchanged.
- Every tab has a stable Grid cell, frame, Header container and Body container. Explicit Grid columns determine docking placement; Flex assigns Header and Body height. Floating changes that same frame to `position: fixed` without changing its parent or replacing Body.
- A floating frame's zero-sized Grid cell establishes a stacking context at the float layer. CSS `order` expresses float depth within that layer; DOM order stays sorted by tab identity. Raising many floats cannot increment their layer past menus. Selection and strip order never reorder the content-node list.
- Common ancestors have no transform, clipping or enclosing stacking context. Docked cells own collapse transforms and visibility; each frame clips its content. Fullscreen changes the same root's width and docked layer. The right panel carries no window-drag pulse of its own: one shell-owned watcher measures the marked rows each frame while the surface can move and pulses the recall mark itself, so no layout code copies content positions.
- Split and float gestures retain their existing measurements and operation state. These update user-selected split fractions and float rectangles, not a second Browser rectangle. Browser resize and content sizing use normal CSS layout.

### Session and tab lifetime

`SidebarRightTabDefinition.keepMounted` enables lazy retention for a type. Desktop Browser enables it; other types keep visibility-based body mounting. A retained body is first created on display, then survives hiding until its occurrence or provider lifetime ends. The policy is not persisted and does not select a storage partition.

`SidebarSessionView` acquires and releases one `SessionReference` using the independent `sidebarView` source, and owns its committed-mount count and retained-Body holds. `SidebarSessionViews` manages selection, retention policy and view indexes; it delegates lifetime operations to the view rather than mutating its counts or releasing its reference. `RightbarRoot` receives `SidebarSessionViewSnapshot` values and the existing injected callbacks, not resource-owner objects. It renders each through its own explicit `SessionProvider`, with a stable Session key; the renderer's general Session-remount semantics remain unchanged.

Tabs contribute Body-retention holds rather than independent Session references. The View's stable `retainTab` callback reaches its seat through owner props, so replacing Session injection bindings does not release and reacquire those holds. Those holds follow the existing occurrence signal, including a new signal after close-and-undo; the view does not create a second tab lifetime. A retired view stays in the collection's reference index until its own disposal removes it, so plugin shutdown can also reach views whose React mounts have not finished.

Only the selected Session reports frame occupancy or binds public Sidebar navigation. Background tab actions still address their own adopted store. `tab.visible` includes Session and global-panel visibility; floating does not make a background Session visible. A Session change or global panel hides its whole content tree, while Sidebar collapse hides only docked cells and leaves foreground floats visible. Hidden content is inaccessible to pointer and keyboard input, and hidden body focus is blurred.

A background Session with no initialized retained body leaves the view list. Its reference releases after its committed React root unmounts, avoiding scope disposal underneath a mounted subtree. Plugin disposal releases all references, including retired views awaiting unmount. The Sidebar plugin depends on `sessions` and `uiSession`, so Cordis unloads it when either dependency ends; `ui-session` owns binding invalidation. Views do not register disposal callbacks on the shared Session Context. Catalog absence alone is not treated as deletion. Unvisited Browser tabs and unrelated Sessions are not eagerly opened.

### Provider responsibilities

`BrowserFrame` remains navigation and observable page state. Presentation creates and attaches the carrier DOM, without pane, clipping or stacking knowledge. Electron's provider receives physical attach/detach callbacks: hiding retained content emits neither, while an actual unmount cancels pending attachment and releases the guest. A subsequent physical mount recreates it from its known address. Disposal waits for pending creation and guest releases; an acquisition completing after cancellation is released rather than attached.

The [Desktop Browser decision](../feature/2026-09-20-desktop-browser-webview.md) retains guest security, shared IPC declarations and Workspace partition ownership. Separate tabs and Sessions never share one page instance merely because they share a storage partition. Web remains disabled by default and retains its iframe carrier when explicitly enabled.

### Retention versus recovery

| Operation | Content handling |
|---|---|
| Switch tabs | Hide the old retained cell; display the target's existing body. |
| Split, reorder or move to another pane | Change logical placement and Grid assignment, without moving Body. |
| Float, dock back or raise | Change the same frame's CSS mode or cell paint order. |
| Collapse Sidebar | Hide docked cells; foreground floats remain visible. |
| Session A → B → A | Hide and reshow A's original tree instead of loading its saved URL. |
| Close, provider unload or actual generation termination | Release the body and guest; undo creates a new occurrence. |
| Application restart or window reload | Show the saved title and URL; load only after an explicit restore or address submission. |
| Guest crash | Retry through the provider; page memory and native history are not durable. |

[Layout and provider recovery](2026-09-14-sidebar-layout-provider-recovery.md) remains independent: persisted tab identity, placement and address support cold starts, not DOM serialization. A hidden page may continue scripts, media and networking.

## Alternatives considered

**Hide panes only.** Collapse works, but moving between panes or into another floating portal still changes content ancestors.

**Retain bodies only in the foreground Session.** Session-slot remounting disconnects the page and loses its live state on Session switches.

**Give each tab its own Session reference.** A view's tabs share one `SessionProvider`, whose reference must exist before their bodies render. Per-view ownership covers that parent and its children without an additional reference lifecycle for each tab.

**Cache and reparent DOM.** Ordinary reparenting invokes Electron disconnection. Atomic-move dependencies, private attachment APIs and lifecycle monkey-patches are not used.

**Position Browser content in a separate overlay.** Measurement or CSS anchors can align an overlay, but its content remains outside the parent Grid/Flex layout that must own its sizing and clipping.

**Use native popovers.** Top-layer elements cannot be covered by ordinary Portal content through `z-index`. Migrating menus and dialogs into another stacking system expands the work beyond Sidebar; the implementation preserves the existing Portal and layer model.

**Raise floats by increasing their root z-index.** An unbounded float count can cross menu and modal layers. Equal-layer Grid cells with CSS paint order retain both stacking and DOM identity.

**Save the URL and rebuild when hidden.** This cannot preserve forms, script state, scroll position or native history. It is recovery after loss, not live retention.

## Consequences

Layout correctness belongs to Sidebar/DockKit rather than Browser. The cost is stable content containers and explicit Session-reference ownership: background retention holds Session scopes and subscriptions as well as page memory. There is no implicit LRU or idle timeout; future reclamation requires an explicit suspension/recovery policy. Other tab types do not automatically acquire these costs.

Sidebar/DockKit own chrome, float stacking, focus and platform styles as well as retained content placement. The [docking infrastructure](../feature/2026-09-04-right-sidebar-docking-infrastructure.md) owns the layout engine, persistence and tab-type navigation; the [Desktop Browser decision](../feature/2026-09-20-desktop-browser-webview.md) owns guest navigation, storage and security.

## Verification

Focused tests cover retained bodies across Session-source registration and removal, persisted-layout validation, and existing Sidebar presentation. Host and Client TypeScript compilation passes. The user manually accepted a rebuilt Electron cold start; no GIF was recorded. Dedicated real-Electron evidence for guest identity, form and history retention, multi-float paint order, resizing, clipping, drop hints, focus and platform window controls remains separate from these unit tests.
