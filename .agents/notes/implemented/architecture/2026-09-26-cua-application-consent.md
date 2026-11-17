# Agent Note: Application consent for native Computer Use

Status: implemented

English | [中文](2026-09-26-cua-application-consent.zh.md)

## Problem

macOS privileges authorize an execution host, not a user's choice of target application. Retained app and window objects can outlive that choice. Concurrent permission decisions must not restore access after the user revokes it.

## Decision

The CUA executor owns application consent for every object-API and native-tool dispatch. It uses the existing User Questions service for human decisions and profile-scoped domain storage for saved grants. Its fixed approval presentation reuses the tool-approval card without adopting the session's tool-approval policy. Native icons and names are presentation metadata, excluded from saved identities and model results. General tool approval and operating-system privileges remain separate requirements. Arbitrary persistent PTC code and separately authorized shell tools retain their own execution authority.

System-permission buttons call the native helper on the DSH host and remain available to remote browsers. The [usage documentation](../../../../packages/experimental/cua/README.md#use-this-package) explains where to complete authorization; the page has no persistent remote-access notice.

Application identity is owned by [bundle-ID consent](2026-10-25-cua-bundle-id-consent.md), which supersedes this note's original path/signature choice. That original choice prevented copied or replaced applications from inheriting access, at the cost of separate grants per installation and no saved grants for unsigned applications. Enforcement and human decision ownership remain as described here.

Cold application selection prepares an executable identity and handle without launching. The same consent decision guards the private launch continuation, and the helper checks the executable again before launch and binds the resulting process afterward. Selections with a bundle identifier retain that identity after launch; an application without one uses its canonical executable path before and after launch and can save that grant. Preparing metadata before asking avoids starting an application the user refuses.

Conversation decisions survive provider disposal and DSH restart according to [profile consent storage](2026-10-19-cua-profile-consent-storage.md). That decision owns persistence, migration and cross-process revocation. The executor continues to serialize application selections within a conversation, refuse repeated prompts after denial, and give an explicit long-term grant precedence over conversation refusals.

Revocation invalidates the Agent connections that retain the application's handles, then awaits native cleanup. Reauthorization uses a fresh connection, so old app and window snapshots cannot become valid again. The [native object decision](2026-09-17-experimental-cua-object-api.md) continues to own process identity, coordinate semantics, and separation from the evaluator.

## Alternatives considered

**Trust model instructions or hide controls.** Retained objects and direct tool calls can still reach native operations. The executor must enforce the decision at dispatch.

**Persist application names or unsigned paths.** A replacement can reuse both. [Bundle-ID consent](2026-10-25-cua-bundle-id-consent.md) owns the identity choices and the decision to share permission between installations.

**Add an approval database or Session control stream.** User Questions already owns interactive answers. The existing domain service provides durable state without introducing a dedicated database or Session control stream; storage tradeoffs are owned by the profile consent decision.

**Disable permission buttons based on the browser address.** A user may operate the DSH host through screen sharing and complete authorization there. Port forwarding and proxies make the address an unreliable indication of whether the browser and DSH run on the same computer.

**Use the nearest GUI ancestor as the permission target.** A source-built Desktop app can sit between Terminal and the helper while macOS still attributes Accessibility and Screen Recording to Terminal. Process responsibility supplies the system’s attribution; ancestry alone does not. The optional SPI adds compatibility risk, so lookup failure omits the application instead of guessing.

**Keep the native context after revocation.** Its application lookup can return an earlier handle and retain window snapshots. Closing the Agent connection discards its native context through existing transport cleanup; preserving unrelated handles would require a native per-application retirement protocol.

## Consequences

Refusing or revoking one application also invalidates other application handles on the same Agent connection. Those applications require fresh selection; session and saved grants remain reusable. Other sessions with independent connections remain unaffected unless they also hold access to the revoked application.

Explicit enablement may start the shared helper for a read-only permission probe. The helper captures the application identified by macOS process responsibility before readiness releases the launcher, retaining its name and icon after reparenting. The optional native query is dynamically resolved; unavailable attribution uses generic system-prompt guidance. The macOS prompt remains authoritative. Enabling does not request macOS authorization or inspect application content.

Application decisions and failure results are exercised through policy regressions and the recorded CUA scenario. Desktop binary distribution, signing, and packaged-host permissions remain outside the source-launch workflow.
