# Agent Note: Retained Desktop browser webviews

Status: implemented

English | [中文](2026-09-20-desktop-browser-webview.zh.md)

## Problem

An iframe cannot expose cross-origin navigation or render sites that refuse embedding. An Electron guest loses forms, scroll position and native history if its tab body unmounts on selection or container changes. Page lifetime must therefore remain independent of visibility and layout changes.

Independent per-tab storage also prevents related pages in one Workspace from sharing site login state. Page lifetime and storage ownership need different owners.

## Decision

Desktop uses `<webview>` through `ElectronWebViewImpl`; Web retains its opt-in iframe carrier. The [Sidebar Browser decision](2026-09-16-sidebar-browser.md) owns shared tab behavior and iframe limitations; this note owns the Desktop carrier and Workspace-keyed partitions.

The [stable Sidebar mounting decision](../architecture/2026-09-20-sidebar-retained-tab-layout.md) owns retained Session and tab containers in real CSS layout. Workspace storage ownership and baseline guest security remain with this note.

- `BrowserController` owns address commands and recoverable presentation state. Native history stays in the guest; actual URL and title observations update the persisted address.
- Controller registries are keyed by DSH Session, independently of presentation bindings. Rebinding replaces the store writer without recreating the page.
- `electron/pages.ts` composes the Electron navigation provider and presentation object. `ElectronWebViewImpl` owns guest leases and native navigation; `ElectronWebviewPresentation` creates the tag and attaches it inside the Sidebar-owned content container.
- The Desktop Browser type declares `keepMounted`. Sidebar retains its DOM ancestors across hiding and docking; CSS owns layout and clipping. Docking gestures disable guest pointer input, and body-local drop hints use normal stacking. A physical unmount cancels pending attachment and releases the guest; a later mount recreates it from the known address.
- Tab occurrence cancellation, plugin unload and window destruction release guests. Guest crashes leave a retryable failure; Reload creates a new guest. Application restart offers the saved title and URL for explicit restoration; it creates no guest until the user restores or submits an address. Page memory and native history are not restored.

The standard `./types` subpath exports the shared lease, reservation, open-request and bridge declarations through a declaration-only `types` condition; Desktop consumers use `import type`. There is no runtime default, extra JavaScript artifact or early Host bundling for these declarations. Preload exposes scoped operations and callbacks, not raw IPC or Electron objects.

Browser has separate Host and Client compiler programs. Desktop and the Host aggregate reference only `tsconfig.host.json`, which compiles the package root and shared bridge declarations; the Client aggregate references `tsconfig.client.json` for the browser implementation. The package root tsconfig is solution-only. This keeps Client consumers of generated `/remote` declarations out of the Host compilation that precedes Typert generation.

### Storage ownership

`DesktopBrowserGuests` assigns a random, non-persistent Electron partition to each canonical CWD account. The Client uses the Host-normalized `WorkspaceView.path`, not the Workspace record UUID, so recreating a Workspace at the same directory does not change its storage account key. Browser tabs whose DSH Sessions resolve to that CWD share the account; Sessions without a resolved Workspace remain separately isolated. Workspace membership is resolved after the Client receives its authoritative baseline and is fixed for a guest occurrence. The CWD key controls sharing, not disk persistence.

Closing a tab releases its guest, not its account's cookies or storage. Cookies, localStorage, IndexedDB, Service Workers and cache remain partition-owned and subject to normal origin rules. DOM, native history and sessionStorage remain page-owned. Account partitions survive window recreation within the Electron process but do not persist across application exit.

### Initial guest policy

Only the primary application window enables `webviewTag`. The main process accepts guest reservations only from that window's application top frame and validates a one-use lease, partition and inert initial `about:blank` document before allowing the guest. The main process replaces renderer-supplied preferences: no Node integration, guest preload, nested webviews, plugins, insecure content, dialogs or drag navigation; sandbox, context isolation and Web security stay enabled.

Guest Sessions do not register the application protocol or inherit the application's authenticated request forwarding. Permission requests and checks, device access, display capture, downloads, native popup windows and HTTP authentication prompts are denied. Approved direct HTTP(S) popup requests without a POST body are routed through their live lease to a new Sidebar tab; scripted blank-window and POST popup flows remain unsupported. Navigation accepts credential-free HTTP(S); request filtering rejects local-file and privileged schemes and the known DSH Host endpoint, including common loopback aliases. This is not a general private-network or DNS-rebinding firewall.

The Desktop toolbar has no sandbox-disable switch. The implementation adds no remote-debugging endpoint or browser-use integration. A future automation provider requires an authenticated, target-scoped broker rather than access to every application target. The separation of a target/lifetime handle from navigation commands follows the same distinction as Playwright's Android WebView and Page objects; device-level input is a separate responsibility.

## Alternatives considered

**Render the guest in a visibility-mounted tab body.** Unmounting disconnects the guest. Direct mounting requires the Sidebar's retained body and stable ancestor mechanism.

**Move the guest between visible and hidden DOM containers.** Electron 44's `WebViewElement.disconnectedCallback` detaches the guest and resets its internal instance. Retaining the element reference or React key does not preserve that instance; the parent stays fixed instead.

**Use one partition per tab.** This isolates site accounts between related pages. Workspace ownership provides the requested sharing without sharing the application Session; a tab still owns its own guest.

**Change the partition of an active webview.** Electron fixes the partition before first navigation. Selecting another isolation scope requires a replacement guest and an explicit policy for existing site data, not a live attribute toggle.

## Consequences

Sidebar-owned stable ancestors preserve the page without Browser-owned geometry or occlusion handling. Hidden guests retain page memory and may continue network activity; there is no idle eviction policy. Persistent storage, selectable isolation scopes and permission-grant UI remain separate work. Temporary Workspace partitions are the current policy, not a promise that Workspace isolation always implies temporary storage.

Focused tests cover native navigation error recovery, preload listener scoping and migrated iframe behavior. They do not establish real Electron attachment timing, overlap, focus, platform styling or storage isolation; those remain runtime verification gaps. No GUI recording accompanies the change. This implementation is not evidence that the complete browser security policy is ready for release.

The package's Electron provider, presentation, page factory and Workspace storage resolver live in `src/client/electron/`. That directory is temporarily excluded from per-file coverage until a native Electron harness covers guest behavior; its unit tests still run. Shared Browser controllers, restoration UI, iframe code and Sidebar retention remain subject to the existing coverage requirements.
