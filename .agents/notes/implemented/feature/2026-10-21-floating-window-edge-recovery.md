# Agent Note: Spring-based edge recovery for floating dock panels

Status: implemented

English | [中文](2026-10-21-floating-window-edge-recovery.zh.md)

## Problem

The dock kit's floating panels are the client's floating windows. `FloatLayer` and the retained `DockLayout` renderer draw them in viewport coordinates through one shared gesture hook, `useFloatGestures`, and the right Sidebar embeds them, so the same panels run in the Web client and inside the Desktop window. Their drag followed the pointer one to one with only a top floor (`--dsh-dockkit-float-top`, which keeps the header below the Windows caption). A panel could therefore be dragged past the left, right or bottom edge until its header was out of reach; a viewport that shrank left a panel outside it; and the creation cascade could place a new panel outside a small viewport. The required behavior is that a panel pushed past an edge visibly resists, and on release is pulled back inside with spring physics instead of being stopped by a wall or left outside.

The reference implementation examined, Claude Desktop, has no portable edge-recovery rule: its Electron fallback corrects an off-screen window once, without animation, on the right and bottom edges only. The behavior had to be designed, not ported.

The change keeps these obligations: a panel header is always reachable; one gesture still records at most one history entry; reduced motion is honored; the persisted Sidebar layout format and every embedder stay unchanged; and the motion is deterministic enough to test without a real browser clock.

## Decision

The behavior lives entirely in `packages/client/ui-dockkit`, inside `useFloatGestures` and the pure engine helpers it calls. Both float renderers take their rectangles from that hook through `rectOf`, so Web and Desktop share the behavior, and no embedder, shell or persisted format changed. The rule extends the floating panels of [right Sidebar docking](2026-09-04-right-sidebar-docking-infrastructure.md) and the fixed-position floating frames of the [retained tab layout](../architecture/2026-09-20-sidebar-retained-tab-layout.md); it supersedes neither note.

### Legal region and displayed position

The legal region of a panel is the viewport (`window.innerWidth` by `window.innerHeight`) with the existing top floor: the Windows caption height plus 20 px when `data-windows-titlebar` is set (20 px in native fullscreen), otherwise 0. `floatBounds` reads only these values and the root's attributes, so starting a gesture forces no layout. `legalFloatRect` projects a rectangle into the region per axis; when a panel is wider or taller than the region it is drawn at the region's size on that axis, so its header controls and its resize corner stay on screen; the stored size is unchanged.

A panel draws at its stored rectangle projected into the viewport. The stored rectangle is never rewritten for the viewport: a shrinking window pushes the panel in without recording an operation, and a growing window returns it toward its stored position. The hook re-reads the bounds at every press and on every window `resize` event, and a gesture in progress uses the new bounds. Persisted layouts that hold off-screen rectangles display inside the viewport without migration.

At rest a panel publishes its rectangle to the `.float` rule as CSS variables through `floatStyle`, and the rule clamps its position and size into the viewport (`100vw` by `100dvh`, which follows `window.innerHeight` as the hook does) and below the caption floor once more; an oversized panel takes the viewport's size there as it does in `legalFloatRect`. A bounds reading the hook has not refreshed, such as one taken before a fullscreen change settles, therefore still leaves the panel inside. A gesture or a return writes its position and size inline, outside the clamp.

### Drag with resistance

A move computes the desired rectangle from the gesture's start rectangle and the pointer travel, then `resistedRect` splits it per axis into the legal projection and the overflow `o` beyond it and draws it at `legal + sign(o) * K * |o| / (K + |o|)` with `K = FLOAT_RESISTANCE = 120` px. The mapping applies on all four edges, including above the top floor, is continuous, has slope 1 at the edge, and approaches `K`:

| pointer overflow (px) | panel displacement past the edge (px) | share of the overflow |
|---|---|---|
| 10 | 9.2 | 92.3% |
| 40 | 30.0 | 75.0% |
| 120 | 60.0 | 50.0% |
| 400 | 92.3 | 23.1% |

A resize clamps the bottom-right corner to the region through `boundedResize` and keeps `FLOAT_MIN_SIZE`; resizing has no resistance, because a corner that lags the pointer reads as a broken handle.

### Release and spring

A release records the legal rectangle: `moveFloat` or `resizeFloat` when it differs from the legal rectangle at the press, otherwise only the raise a click records. A click on a panel drawn projected therefore keeps its stored rectangle. A move or resize therefore records only legal rectangles, and undo restores the pre-gesture position in one step. Panel creation (the drop rectangle of `floatTab` and the cascade) can still store a rectangle outside the viewport; the projection draws it inside. When the panel was drawn outside the legal region, the hook keeps a preview and springs it from where it was drawn to the recorded rectangle, then clears the preview. A release inside the region animates nothing.

The spring in `engine/spring.ts` is underdamped, because its bounce goes inward and is always legal: response 0.32 s and damping ratio 0.72. An overflowing axis starts with the velocity of the drawn panel over the last 100 ms of the drag, so the speed is continuous across the release; it is capped at `SPRING_MAX_VELOCITY` (1500 px/s), and `launchVelocity` caps its outward part at `omega0 * (K - d)` for a drawn overflow `d`. A fling past the edge travels further before it turns back, and because the spring carries an offset `d` with speed `v` at most `d + 0.46 * v / omega0` from its target, the whole return stays within `K` of the edge. An axis that did not overflow keeps still. Per axis the update is:

```
a = -omega0^2 * (x - target) - 2 * zeta * omega0 * v
v = v + a * h
x = x + v * h
```

`stepSpring` integrates in equal substeps of at most `h = 1/480 s`, so the motion does not depend on the frame rate. One `requestAnimationFrame` loop in the hook clamps a frame to 64 ms, ends at the target when a frame gap exceeds 250 ms or 900 ms have passed, and otherwise stops when each axis is within 1 px of the target and slower than 60 px/s. From rest, a 200 px overflow settles in 367 ms with an inward overshoot within one percentage point of the analytic bound `exp(-pi * zeta / sqrt(1 - zeta^2)) = 3.8%`. The integrator is pure and takes `dt`, so the engine keeps its rule of reading no clock.

A press on the grip or the corner during a return cancels it and picks the panel up where it is drawn. A move does so through `unresistedRect`: it inverts the resistance, so zero pointer travel draws the same rectangle. A resize keeps the drawn origin and caps only the corner by the viewport; its release records the legal rectangle and springs the origin inside, as does a resize whose viewport shrank past its origin. Either way a release in place resumes the return without recording a second operation. One hook runs at most one return. A window resize ends a running return at its recorded rectangle, a press on another panel ends it at its target, a change of the panel's record that does not project to the target (an undo, a dock, a close) ends it at the new record on the next frame, and unmounting cancels the pending frame.

### Reduced motion

When `matchMedia('(prefers-reduced-motion: reduce)')` matches, a move clamps to the legal region with no resistance, and release records the legal rectangle with no animation. Environments without `matchMedia` report no preference. The rule only removes motion; it never removes the legality correction.

### Change scope

The change touches one package, `@deepseek-ai/dsh-client-ui-dockkit`, and leaves its exports and `DockIntents` unchanged; the `TabRenderer` contract now states when the kit reuses a body.

| File | Change |
|---|---|
| `packages/client/ui-dockkit/src/engine/geometry.ts` | `FloatBounds`, `FLOAT_RESISTANCE`, `legalFloatRect`, `resistedRect`, `unresistedRect`, `boundedResize` |
| `packages/client/ui-dockkit/src/engine/spring.ts` | the pure spring integrator, its rest predicate `springSettled`, `launchVelocity` and its timing limits |
| `packages/client/ui-dockkit/src/components/FloatLayer.tsx` | `useFloatGestures`: viewport projection, resistance, release spring, drawn-velocity sampling, reduced motion, frame loop and cancellation; `rectOf` and `floatStyle` for both renderers |
| `packages/client/ui-dockkit/src/components/TabLayout.tsx` | draws the hook's displayed rectangle through `floatStyle` |
| `packages/client/ui-dockkit/src/components/TabBody.tsx` | the memoized body every layout (`FloatLayer`, `TabLayout`, `TabPanel`) draws |
| `packages/client/ui-dockkit/src/contract/adapter.ts` | when `TabRenderer` is called again |
| `packages/client/ui-dockkit/src/components/dockkit.module.css` | the resting clamp of position and size on `.float` |
| `packages/client/ui-dockkit/README.md` pair | the edge rule beside the float renderer description |
| `apps/web/tests/sidebar-right.e2e.ts` | a browser case for the resistance and the return |

`ui-sidebar-right` and its persisted layout schema, the `apps/web` source, `apps/desktop`, the shared primitives and the theme are untouched. No dependency was added.

## Testing

`tests/float-bounds.client.spec.ts` covers the projection (inside, each edge, corner, the top floor, an oversized panel), the resistance (the table values, slope 1 at the edge, monotone growth bounded by `K`, independent axes), its inverse and its cap, the bounded resize, and the legal size kept by the resistance and its inverse. `tests/spring.client.spec.ts` covers settling inside the deadline, the overshoot bound, frame-rate independence at 30, 60 and 120 Hz, the effect of release velocity, determinism, and the launch cap keeping every return within `K`. `tests/app-region-styles.client.spec.ts` pins the resting clamp in the stylesheet.

`tests/float-recovery.client.spec.tsx` renders `FloatLayer` over a live controller with hand-driven frames and clock: the resisted preview past an edge, exactly one legal `moveFloat` per release and the spring to it with an inward overshoot, undo in one step, fling against slow push, a fast fling staying within `K`, a drag above the top floor, no animation for a release inside, a push that ends at the stored position, a press mid-return picking the panel up without a jump, the stall snap, the deadline, a body not re-rendered through a drag and its return but re-rendered for a new renderer, a corner press during a return picking the panel up where it is drawn and a resize from there springing in, a resize whose viewport shrank past its origin recording a legal rectangle, with no animation under reduced motion, the 20 px floor on a Windows root without a published caption height, a return yielding to an undo, a close and a press on another panel, unmount cancellation, both reduced-motion answers, the viewport projection on shrink and growth without any intent, a click on a projected panel recording nothing, a window resize during a gesture bounding its release, a resize ending a return, and an off-screen stored rectangle drawn inside. `tests/tab-layout.client.spec.tsx` adds that a float drag re-renders no docked or floating body until the renderer changes, and `components.client.spec.tsx` the same for a `DockSurface` divider drag. The existing `FloatLayer` and `TabLayout` specs still pass with their position assertions read from the resting variables, including the rule that starting a gesture forces no layout read; every changed source file is fully covered. `apps/web/tests/sidebar-right.e2e.ts` drags a Sidebar float past the right and bottom edges in Chromium, checks that the drawn panel stays within 120 px beyond them, waits for the release to settle flush against both edges, then publishes a resting rectangle far outside and larger than the viewport and checks that the stylesheet alone draws it exactly over the viewport.

## Alternatives considered

**Hard clamp at the edge.** Stopping the panel at the viewport edge is the cheapest correct rule, but it feels like hitting a wall and gives no sense of the boundary before contact. It remains as the reduced-motion path.

**Clamp during the drag and rebound on release.** Clamping the drag at the edge and converting the outward pointer speed into an inward bounce keeps every frame inside the viewport. It hides how far the user pushed, so the bounce has no visible cause; the resistance shows the push and still bounds the overflow at 120 px.

**Eased tween on release.** A fixed 240-300 ms ease-out from the released position is predictable, but it carries no velocity, so a fling and a slow push return identically, and a press during it either jumps or restarts. The spring keeps velocity continuous and is interruptible.

**Store the off-screen position and correct it later.** Recording the released rectangle and fixing it on the next render would persist off-screen positions and make undo restore them. Recording the legal rectangle keeps one history entry per gesture with a legal value.

**Rewrite stored rectangles when the viewport shrinks.** Moving panels through operations on resize would add history entries the user never made and change persisted layouts on every window resize. Projecting at render achieves the visible result without either, at the cost of the elastic return described below.

**Native always-on-top OS window.** A real Electron floating window could float above other applications, but only on Desktop; the Web client cannot do it at all, and native frameless dragging gives no per-frame control, so the resistance would be impossible and the spring could only start after release. It is a separate product decision with its own window, IPC and platform work, and this decision does not preclude it.

**Animation library dependency.** A spring library would replace a pure integrator of a few dozen lines and its tests with a new dependency in a statically linked package. The integrator also has to be clock-free for the engine's deterministic tests.

**A shared primitive in `ui-primitives`.** Placing the hook in the primitives package would widen the change to a second package with no second consumer. It can move there when another floating surface needs it.

## Consequences

Floating panels can no longer be lost off screen, in either client, and a push past an edge reads as a pull back rather than a wall. History, persistence and every embedder are unaffected, and the motion is covered by deterministic tests instead of manual checks.

A drag and the spring update the preview through React state, so the layout re-renders on every frame, for up to 900 ms after release as well. Every layout draws tab bodies through `TabBody`, which is memoized on the renderer and the tab record, so such a frame re-renders only the panel frames and headers (the header still calls `renderTabTitle`), never the tab bodies; writing a transform on the panel element directly is the fallback if the remaining cost measures as a problem. A panel pushed in by a shrinking window returns toward its stored position when the window grows, which a user who expects it to stay where it was pushed may find surprising. Content inside a panel, such as a webview, can observe up to 900 ms of motion after release. The constants are tuned for a mouse or trackpad; touch input works through the same pointer events but remains untuned.
