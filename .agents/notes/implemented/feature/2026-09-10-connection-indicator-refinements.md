# Agent Note: Connection indicator state and interaction refinements

Status: implemented

English | [中文](2026-09-10-connection-indicator-refinements.zh.md)

## Problem

The sidebar connection pill hid its affordance behind a hover swap: outage and retry-attempt states replaced their label with **Reconnect now** on hover or focus, so every state had to reserve the widest supplied label to keep the control from resizing. A retry that resolved in under a second flickered the connecting pill in and out, and state changes and unmounts jumped with no transition.

## Decision

**The disconnected pill shows its action statically.** [ConnectionIndicator.tsx](../../../../packages/client/ui-primitives/src/ConnectionIndicator.tsx) renders a permanent retry glyph (`IconRefreshOutline14`) beside the outage copy (`连接异常，刷新重试` / `Disconnected`; the Chinese copy also names the retry action); clicking the pill still reconnects immediately. The hover label swap and the hidden widest-label size-reservation spans are gone, so the pill sizes to its current label. The connecting state shows a rotating-arc spinner instead of the exclamation glyph. Appearance and removal fade over 150ms — swaps between visible states replace content in place: `EXIT_MS` delays unmount to match the stylesheet's `.leaving` transition, and `prefers-reduced-motion` disables every animation and transition. Chrome settles at 28px height, 8px horizontal padding, 4px icon gap, 13px radius, and a 1px border of the label color at 20% alpha.

**The shell owns attempt pacing.** [SettingsRoot.tsx](../../../../packages/client/ui-settings-general/src/client/SettingsRoot.tsx) keeps the connecting pill visible for at least `CONNECTING_MIN_VISIBLE_MS` (800ms) so sub-second retries do not flicker; every attempt, manual or automatic, reads the one label `重新连接中` (`connection.connecting`). The two-second recovery confirmation (`RECOVERY_CONFIRMATION_MS`) starts when the recovered pill becomes visible, so a hold that delays its appearance never shortens the confirmation. Both timings are built-in presentation constants of their owners, not configuration.

## Alternatives considered

**Animating width changes.** A FLIP-style measured pixel transition (remember the old width, pin it, transition to the new measurement) needs a layout effect and imperative style writes; the fade-only change reads calm enough without them.

**Swapping to the retry glyph only on hover.** Showing the retry glyph permanently states the affordance without requiring any pointer interaction, matching the static label; a hover cross-fade adds interaction-dependent state and conveys nothing extra.

**Scaling on enter/exit.** A 0.98 scale beside the opacity fades reads as jitter at 12px text, so only opacity animates.

**Naming manual and automatic attempts differently.** `ConnectionController.emitState` deduplicates repeated `connecting` states across backoff attempts, so the shell cannot observe attempt boundaries: a shell-held manual-retry flag either flips the label mid-hold or sticks across later automatic attempts. Distinguishing the copy correctly requires the connection layer to expose the attempt origin, which this change does not need — both attempt kinds read the same label.

## Consequences

`ConnectionIndicator`'s `reconnectLabel` prop and its size-reservation spans are removed from the pre-stable API; the sole consumer (`ui-settings-general`) is updated in the same change. `settings-root.client.spec.tsx` pins the 800ms hold, the single attempt label held steady through the hold, and the visibility-based confirmation window; `atoms.client.spec.tsx` pins the exit-duration unmount; `lifecycle-chrome.e2e.ts` and its ARIA golden replay the recovery flow in a real browser. Both packages' READMEs restate the interaction.
