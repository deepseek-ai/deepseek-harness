# Agent Note: File drag ownership outside the application layout

Status: implemented

English | [中文](2026-10-19-file-drag-plugin-ownership.zh.md)

## Problem

Image dragging spans conversation images, sidebar previews, and composer drop targets. Original files must survive source unmount during a drag, and failures must remain visible after the originating panel closes. An application-root image provider puts feature state in layout and makes independent image entries depend on an undeclared React ancestor.

## Decision

The [file-drag plugin](../../../../packages/client/ui-file-drag/README.md) owns generic file preparation, browser transfer tokens, retained original files, desktop bridge selection, and transient failure feedback. Consumers receive preparation and error callbacks through their slot or Factory injection. The plugin registers its feedback through `shell.overlay`; layout declares the generic slot and has no image dependency. The shared image primitive owns gestures and cancellation. Images are the first consumer, while MIME naming and transport accept other files.

## Alternatives considered

**Root React provider.** It preserves transfer lifetime but adds image-specific assembly to the layout package and hides dependencies from slot registration. Moving the same wrapper into the renderer would move the feature coupling into another generic owner.

**State on each image.** It avoids shared assembly but cannot deliver the retained file after the source unmounts or keep a late failure visible after the panel closes.

**Direct browser File only.** Manual macOS Chrome 154.0.8037.93 drags of PNG and PDF fixtures produced a populated `dataTransfer.files` in trusted `dragstart`, but empty files in trusted same-page and cross-window drops. Finder received filename-only text clippings. These measured failures require the application-local token path; they do not establish behavior in untested browsers or cross-tab delivery. Desktop retains Electron native file dragging.

## Consequences

One plugin lifetime governs transfer state, a native source-node end listener, and drop completion. The source listener remains attached after React unmount. Independent render roots can share a transfer without sharing a React ancestor. Custom compositions must load the service and declare the feedback slot; custom image Factory registrations supply the required callbacks. Application-local browser tokens are accepted only over the composer; native Desktop files retain the full-page drop overlay. Plugin disposal removes feedback and clears retained files. Loader-backed browser scenarios cover source removal and delivery, while focused tests cover local resource authorization and cleanup failures.
