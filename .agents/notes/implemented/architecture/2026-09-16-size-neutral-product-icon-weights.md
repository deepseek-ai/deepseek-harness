# Agent Note: Size-neutral product icon weights

Status: implemented

English | [中文](2026-09-16-size-neutral-product-icon-weights.zh.md)

## Problem

Shared product-icon exports encoded one historical render size in each symbol name even though every component accepted a `size` prop. Consumers also thickened selected icons through local CSS or separate drawings, so emphasis had no named library choice and could drift between features.

## Decision

Every shared product glyph exports a size-neutral `Regular` and `Medium` component. `Regular` renders the supplied one-pixel artwork, while `Medium` renders the same paths with a 1.3px inherited stroke; filled regions remain unchanged. The `size` prop controls rendered dimensions, and the former numeric suffix survives only as the default size when a glyph has no 16px source.

`LinkIconRegular` and `LinkIconMedium`, `ReferenceIconRegular` and `ReferenceIconMedium`, and the three `PermissionIcon*Regular`/`PermissionIcon*Medium` pairs follow the same rule. Repository consumers use a named weight instead of a numeric export.

Medium weight is reserved for deliberate emphasis: new-Session controls, Settings trigger and navigation icons, Appearance choices, the composer add button, and clickable artifact-link glyphs. Other existing consumers use Regular. The composer command menu uses `PermissionIconFullAccessRegular` for the permission command because that row names permission elevation rather than the current mode.

## Alternatives considered

**Keep pixel sizes in export names.** Rejected because the suffix duplicated the runtime `size` prop and created separate names for identical geometry.

**Expose one component with a `weight` prop.** Rejected because call sites would hide the chosen weight inside props; explicit component names keep visual emphasis searchable and reviewable.

**Override stroke width in consumer CSS.** Rejected because source SVG elements can carry their own stroke widths, and local overrides would recreate inconsistent weighting outside the library.

## Consequences

The icon API is intentionally breaking while pre-stable: every consumer names `Regular` or `Medium`, and former 14px call sites pass an explicit size when they share geometry with a 16px export. New product glyphs add both weights from one geometry definition. Fill-only artwork exposes both names for API consistency even when stroke weight does not change its appearance. The hierarchy choices above remain explicit at their render sites rather than becoming global size or opacity overrides.
