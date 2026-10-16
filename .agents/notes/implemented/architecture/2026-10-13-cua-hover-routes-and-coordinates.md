# Agent Note: Background hover and screenshot coordinates

Status: implemented

English | [中文](2026-10-13-cua-hover-routes-and-coordinates.zh.md)

## Problem

Hover-only controls can sometimes be revealed without moving the user's pointer. Treating every hover as a system movement unnecessarily disturbs that pointer. Screenshot pixels also differ from native window points after Retina capture, attachment normalization or model-request resizing; making the model convert them duplicates provider geometry rules.

## Decision

Native hover first uses a same-window element or ancestor advertising both `AXShowAlternateUI` and `AXShowDefaultUI`. Entering its revealed descendants preserves the parent UI; leaving restores it. An unavailable route falls back to the real system pointer. An AX action failure propagates because received effects may be uncertain. The result records the route and whether the system pointer moved. System movement requires the selected foreground app and AppKit's mouse hit test, which excludes input-transparent overlays. No route grants [cross-call ownership](2026-10-13-cua-continuous-hover.md).

Model-facing coordinate input defaults to pixels in the returned screenshot. `relative: true` accepts integer thousandths from 0 to 1000 for click, hover, scroll and drag; it does not apply to AX indices. The Host owns the mapping to native window points. An application-wide observation refreshes its inventory; a scoped observation preserves other windows' image mappings. Window resizing invalidates the old image, while movement preserves local coordinates. Relative endpoints remain inside the window and do not depend on screenshot resolution.

`LlmAdapter.imageRequestTarget` exposes the same dimensions and byte target used by image serialization. DeepSeek and pi-ai share their existing projection functions with this method. Other adapters preserve normalized images unless they declare resizing. Screenshot bytes returned to programs match the request image; its durable source is admitted and stored once. The native PNG metadata is checked against decoded source dimensions before any input mapping is published.

## Alternatives considered

PID-directed movement alone does not establish AppKit hover tracking. The [continuous-hover observations](2026-10-13-cua-continuous-hover.md) retain that limitation. Browser-engine or Electron page input can hover without the system pointer, but needs a separately established connection; a generic native app handle does not provide one.

Making all coordinates relative would discard the familiar absolute-pixel interface. Keeping both modes explicit avoids guessing a coordinate's units from its value. Using capture dimensions alone would miss later image resizing; the provider owns its projection formula.

## Consequences

The native fixture covers alternate-UI reveal, delayed observation, screenshots, descendant entry, one click and exit while sampling the system pointer. Separate owned Chromium/CDP and Electron-input probes verify CSS hover, trusted input and pointer stability; they do not establish automatic access to arbitrary existing applications. Applications without a usable background route still require system-pointer hover.

Unit and provider tests cover Retina and downscaled images, both coordinate modes, endpoint validation, scoped-window preservation, resize invalidation, decoded-image metadata and one-time image storage. Recorded native-tool and PTC sessions retain the model-facing coordinate contract and hover-route evidence.
