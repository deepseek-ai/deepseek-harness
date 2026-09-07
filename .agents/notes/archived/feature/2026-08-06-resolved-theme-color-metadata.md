# Agent Note: Resolved theme color metadata

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-resolved-theme-color-metadata.zh.md)

## Problem

The web client can resolve its theme independently of the operating-system preference, so a single manifest `theme_color` or media-qualified static metadata can disagree with an explicit Light or Dark selection. Browser chrome around an installed or ordinary page then need not match the app surface even though the layout presenter already owns the resolved document palette.

## Decision

The ui-layout `ThemePresenter` owns one `<meta name="theme-color">` alongside its root `color-scheme`, dark-palette attribute, and inline token writes. After applying a resolved snapshot's palette and token overrides, the presenter reads the body's computed `background-color` into the metadata element and inserts that single node into the document head. Subsequent snapshots update the same node, and disposal removes it.

The rendered body background remains the color authority. The PWA manifest carries no static `theme_color` or `background_color`, and `ThemeDefinition` gains no second color field that could drift from the token palette. This also lets a registered theme's base-background token reach browser UI through the same application path as its page surface.

## Verification

The presenter unit contract covers light and dark computed colors, node reuse, and disposal. The ui-layout composition test covers initial insertion, event-driven reuse, and fiber cleanup. The Web browser settings scenario drives Light, Dark, System, operating-system changes, and reload through the shipped composition, asserting one metadata element whose content equals the computed body background with no console errors. The metadata change has no rendered accessibility-tree output, so the existing scenario golden remains unchanged.

## Alternatives considered

**Set `theme_color` in the manifest.** A manifest provides one app-wide value, so either built-in palette can disagree with it; the manifest deliberately omits the field.

**Declare light and dark metadata with `prefers-color-scheme` media queries.** Media queries follow the operating system, not an explicit in-app selection, and therefore cannot represent the resolved preference.

**Add a `themeColor` field to every `ThemeDefinition`.** A separate value gives custom themes an independent browser-chrome choice, but duplicates the base-background color and permits the page and surrounding UI to drift. A distinct field can be introduced if a supported theme needs that intentional difference.

## Consequences

Supporting browsers update surrounding UI after the client applies its initial resolved snapshot and after every theme change; browsers without `theme-color` support ignore the metadata. Because the value comes from computed presentation, the client must keep a concrete body background. The presenter creates and removes its own node, while unrelated head metadata remains untouched.
