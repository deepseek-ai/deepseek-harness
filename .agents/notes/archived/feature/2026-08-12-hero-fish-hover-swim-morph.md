# Agent Note: Hero fish hover swim morph

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-12-hero-fish-hover-swim-morph.zh.md)

## Problem

Hovering the New Session hero fish (`EmptyHero.tsx` in `dsh-client-ui-conversation`) played a one-shot rigid CSS sway of the whole svg. The user wanted the whale to visibly swim — the tail wagging and the mouth curve lifting — which requires deforming the path geometry itself. CSS transforms cannot bend a subset of a path's curves, and the logo ships as one `FISH_LOGO_PATH` string in `dsh-client-ui-primitives`.

## Decision

Real curve deformation via SMIL `<animate attributeName="d">` cycling `rest → tail-up → rest → tail-down → rest` on the same 1.6s period as the CSS sway, which becomes continuous (`infinite`) for as long as the pointer stays. The two morph targets are generated programmatically (`/tmp`-run script, not checked in): parse `FISH_LOGO_PATH`'s absolute M/C/L/Z commands, rotate the tail region about a pivot with smoothstep falloff weights, bend the mouth/fin swoosh vertically with weight-squared falloff from its body anchor (a smile lift, not a rigid swing — rigid rotation read as detached), and emit structure-identical command strings SMIL can interpolate. The baked path constants live next to the component with the generation parameters documented. SMIL cannot ride CSS media queries, so a `hovering` state gated by `matchMedia('(prefers-reduced-motion: reduce)')` mounts the morph, while the CSS sway sits under `@media (hover: hover) and (prefers-reduced-motion: no-preference)`.

The morphing fish reaches the hero as the fallback of the `conversation.hero.brand.mark` slot; no shipped package occupies it — `dsh-client-ui-brand-official` fills only the sidebar slots, since a feature plugin may not value-import `HeroFish` across packages ([client cross-package rule](../process/2026-08-23-client-cross-package-value-dependencies.md)) and the fallback already is the official mark. `FISH_LOGO_PATH` and `FISH_LOGO_VIEWBOX` are exported from `dsh-client-ui-primitives` for consumers that compose their own svg around the same geometry.

## Alternatives considered

**Vector-tool path editing for the morphs.** No interactive tool in the loop; programmatic weighted deformation was chosen because it guarantees the identical command structure SMIL `d` interpolation requires and makes amplitudes reviewable numbers.

**Blowhole spout on hover.** Removed at the user's request; hover keeps only shape morph and sway.

**Occupying the hero slot with the official mark.** The previous arrangement; rejected because the static occupant shadowed the animated fallback, and animating the occupant instead would need the forbidden cross-package value import.

## Consequences

The hover swim is decorative (`aria-hidden`) and reduced-motion-safe (static logo on hover). The sway CSS targets the stationary `.fishHitbox` wrapper, so a slot occupant would sway too; the body morph lives only in the fallback `HeroFish`. Coverage is the `skeleton.client.spec.tsx` suite asserting slot contract (name, owner props, fallback existence); the keyless snapshot harness records transcripts, not browser animation, so visual verification of the morph stays manual. Regenerating the morph targets requires re-running the (uncommitted) deformation script against `FISH_LOGO_PATH`; if the logo geometry ever changes, the baked constants must be regenerated with it.
