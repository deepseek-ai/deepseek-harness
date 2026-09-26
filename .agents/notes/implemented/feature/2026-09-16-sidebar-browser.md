# Agent Note: Sandboxed Sidebar browser

Status: implemented

English | [中文](2026-09-16-sidebar-browser.zh.md)

## Problem

The right Sidebar can preview addressed workspace files, but it has no independent surface for visiting a Web page. Opening a page outside the application loses the Sidebar's split, float, and tab lifecycle. Treating an arbitrary page like Document Preview content also obscures a different trust model: a Web page controls a live browsing context, while a document renderer receives bytes selected for one preview.

A parent page cannot inspect or drive a cross-origin iframe's internal history. The supported behavior must not imply that capability.

## Decision

`@deepseek-ai/dsh-client-ui-sidebar-browser` registers the multi-instance `browser` right-Sidebar tab type. `SidebarRightTabParamsMap.browser` accepts an optional initial URL so another Client plugin can open a Browser without importing this package's runtime values.

`MarkdownDelegateProvider` gives nested Markdown anchors an optional owner callback for ordinary HTTP(S) activation while retaining native modified-click behavior. Chat places one provider around its node list and opens a new `browser` tab with the URL as typed navigation parameters when that type is registered, or uses the system browser otherwise; the Markdown renderer does not import the Browser feature.

The address parser accepts `http:` and `https:`, including loopback targets; a host name without a scheme becomes HTTPS. It rejects embedded credentials, the application's own origin, malformed addresses, `file:` URLs, and every other scheme. Document Preview remains the local-file surface.

The Web carrier is an iframe; Desktop uses the [retained webview carrier](2026-09-20-desktop-browser-webview.md). Its default Web policy is `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"`; the frame has no direct download or top-navigation flag. Popups escape the sandbox, and a Web popup retains its opener and can use that chain to navigate the top-level application. Same-origin lets the visited origin use its own cookies and Web storage; it does not make a cross-origin target same-origin with DSH. The iframe sends no referrer and adds no package-owned Permissions Policy, so browser defaults and user grants apply. A rightmost toolbar toggle removes the sandbox attribute for that tab occurrence; the mode is not persisted and renders a warning while active. An unsandboxed page can navigate the top-level application under browser activation rules and use downloads, modal dialogs, and input locks. The package performs no Host-side URL probe or proxy.

Each tab receives one `BrowserController` for address validation and carrier-independent commands. `BrowserFrame` exposes navigation, observable address/loading/history/error state, and an optional sandbox control; `BrowserPresentation` owns DOM attachment. `pages.ts` composes these two objects into a `BrowserPage`. `IframeImpl` owns application-known `BrowserNavigation`, while `ElectronWebViewImpl` observes native history. Slot injection exposes keyed controller state through `useBrowserState` and plain callbacks; the React body owns its draft and content container, with no carrier branch, controller instance or observable source.

For the iframe carrier, `BrowserNavigation` keeps the canonical current URL, controlled-load revision, navigation state, and a bounded sequence with its index. A new address drops the forward branch; Back and Forward move the index; Reload recreates the last application-known URL without adding history. Within a live controller, remounting a body reloads its last requested URL. The Session-scoped store persists immutable checkpoints for tab titles and cold-start recovery; it does not serialize a live page.

A controller created from a saved checkpoint offers its last title and URL with a Restore page button. The provider starts idle: mounting the restored tab neither creates a browsing guest nor requests the saved site. Restore, toolbar Reload or address submission starts navigation; a fresh typed-open URL remains an explicit navigation request and loads directly. Before a page is requested, Back and Forward remain disabled, while Reload restores the saved address through the same controller action as Restore. Changing an idle iframe's sandbox does not restore it. This offer belongs to `BrowserControllerState`, not the live `BrowserFrame` interface or the persisted navigation status.

Occurrence cancellation releases the controller. It removes the saved checkpoint only when the Sidebar's authoritative `openTabs` inventory no longer contains that tab. The inventory publishes layout removal before `TabDomain` aborts its occurrence; plugin unload also aborts occurrences but leaves saved tab membership intact. Cleanup therefore does not interpret plugin unload as a request to erase recovery data.

Browser state is presentation state. It does not enter the Session log, model request, resource model, or DockKit layout operations. The existing [right Sidebar infrastructure](2026-09-04-right-sidebar-docking-infrastructure.md), [tab type contract](../architecture/2026-09-05-sidebar-tab-types-and-navigation.md), [resource model](../architecture/2026-09-05-client-resource-model.md), and [Document Preview operations](../architecture/2026-09-08-document-preview-operations.md) retain their existing responsibilities.

## Web navigation states

The Web carrier treats only the first iframe `load` for a controlled revision as confirmation of the application-known URL. A later `load` for that revision proves that the document changed but cannot reveal the new cross-origin URL. Events carrying an older revision are ignored. These states describe active navigation; an unrequested saved checkpoint remains a separate restore offer.

| State | Entry | Address and controls |
|---|---|---|
| `empty` | The tab has no controlled target. | The address is empty. Back, Forward, Reload, and external-open are disabled. |
| `loading` | Address submission, an application-history move, or Reload starts a new revision. | The requested URL remains authoritative. Back and Forward follow application-history bounds; Reload remains available; external-open follows the known target protocol. |
| `known` | The first iframe `load` arrives for the current revision. | The requested URL remains authoritative even when that first load includes an HTTP redirect. The controls follow the same known-target rules as `loading`. |
| `unknown` | A second or later iframe `load` arrives for the current revision. | The last controlled URL is muted and marked `URL changed`. Back and Forward are disabled because iframe exposes no cross-origin `canGoBack` or `canGoForward`; external-open is disabled. Reload starts a new revision at the last controlled URL. |

Address editing is available in every state. An invalid draft reports an address failure without changing the current navigation state. Focusing the unknown address hides its marker and reveals Go; Enter and Go both start a controlled load. For an already requested page, changing sandbox mode reloads the last controlled Web target under a new revision. An iframe `error` event marks only the current `BrowserFrame` revision with a transient load-failure notice; it does not change URL history, and the next controlled document clears it. Browsers do not reliably emit this event for DNS, TLS, mixed-content, CSP, or `X-Frame-Options` failures. `pushState`, `replaceState`, and fragment changes that emit no iframe `load` remain unobservable.

## Electron carrier

The [Desktop webview decision](2026-09-20-desktop-browser-webview.md) owns native page lifetime, Workspace storage sharing, guest policy, and runtime verification gaps. The iframe behavior in this note remains independently useful; its cross-origin limitations do not describe the Desktop carrier.

## Alternatives considered

**Automatically reload saved pages when their tabs mount.** This resumes third-party requests and scripts merely by restoring the layout. An explicit restore action preserves the saved address without opening the site.

**Add a Host embeddability probe and persist the sandbox preference.** Rejected because fetching arbitrary targets on the Host adds an SSRF path, the probe can disagree with later redirects, and a persistent global escape makes later tabs inherit an unsafe choice. Browser instead offers an explicit per-tab, non-persistent sandbox toggle with a visible warning.

**Treat parent-owned history as the complete Web model.** Rejected because it silently leaves a stale address and enabled actions after an in-frame navigation. The bounded parent-owned history remains useful while the current controlled URL is known; the explicit `unknown` state removes claims that the iframe API cannot support.

**Support `file:` URLs in Browser.** Rejected because local files already belong to Document Preview, while browser navigation has a different trust model. Browser refuses the protocol instead of acquiring filesystem or Workspace Files access.

**Proxy Web pages through the Host.** Rejected because a compatible proxy would have to rewrite URLs, CSP, cookies, modules, streams, forms, and downloads while turning the Host into a general outbound requester.

**Implement the Electron carrier in the initial Browser change.** Deferred so the first implementation does not enable a new Electron guest surface without packaged-app evidence for overlay stacking, target lifetime, cookie isolation, and every permission denial.

## Verification

Unit tests cover protocol parsing, delegated Markdown links, controller commands and lifecycle, deterministic navigation-state transitions, bounded history, best-effort iframe errors, and plugin disposal. Keyless Web scenarios boot the shipped composition and exercise message-link routing, HTTP(S), Back, Forward, sandbox control, unknown navigation, and protocol refusal.

Manual cold-start restoration and checkpoint retention across plugin unload have no runtime verification yet.

## Consequences

The iframe carrier exposes no Electron or Node APIs. Many sites refuse iframe embedding or require downloads or top-level navigation withheld from the frame by the default sandbox. An HTTPS application can block public HTTP pages as mixed content or restrict private-network requests, and disabling the sandbox does not bypass those browser policies. Disabling the sandbox otherwise trades its protections for compatibility: the frame can navigate the top-level application under browser activation rules and use downloads, modal dialogs, and input locks. A Web popup that escapes the sandbox retains its opener and can navigate the top-level application through that chain. Neither path adds Electron or Node APIs. The URL gate cannot prevent an embedded page from choosing its own destination. A later iframe load exposes that navigation occurred but not its cross-origin URL; History API and fragment changes can remain completely invisible.

Web site-cookie behavior follows the user's browser and is not isolated per Browser tab. Local files are rejected and remain owned by Document Preview. Persisted URLs can contain sensitive query or fragment values, so users must not enter credentials they do not want retained in application-local browser storage.
