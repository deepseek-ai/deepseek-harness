---
description: "Experimental native read-only Office preview for Desktop."
kind: "package-bundle"
---

# @deepseek-ai/dsh-office-frame-forwarding-bundle

English | [中文](README.zh.md)

## Summary

Office read-only preview is preinstalled and disabled by default. Enabling or disabling it in Plugins applies live, like other optional bundles. Its plugins render only when the Host runs inside Desktop, which owns the native frame transport; in Web the existing PDF and spreadsheet preview remains.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Open **Plugins** in Desktop, select **More** beside **Experimental plugins**, and switch on **Office read-only preview**; once on, it also appears on the main list. Native DOCX, XLSX, and PPTX viewing supports selection, zoom, scrolling, and presentation playback. Unsupported formats and unavailable native rendering retain the existing PDF or spreadsheet fallback. File access remains subject to workspace authorization.

<a id="understand-the-implementation"></a>
## Understand the implementation

[`cordis.patch.yml`](cordis.patch.yml) inserts [frame forwarding](../frame-forwarding/README.md) as the row `frame-forwarding` that every frame-forwarding consumer bundle shares, so another enabled consumer runs on the same instance, and then [Office preview](../client-ui-office-frame-forwarding/README.md) as the row `office-preview`. The bundle contributes no Electron main-process code and no preload: the [Desktop application](../../../apps/desktop/README.md) owns the generic shared-texture API with its hop and ingress addons, the `dshDesktop.textures` preload bridge, and the Desktop Host `sharedTexture` service; the frame-forwarding package owns the native receiver, which runs in the Desktop Host process, and its renderer-side views; the Office preview consumes both. The Office Host plugin reports `availability` to its Client, which registers the native preview only in the Desktop document when the Host renders this workspace locally through frame forwarding. The bundle's package name carries no `experimental` prefix, so profiles that enable it keep their reference when the capability leaves the experimental group; the experimental classification still governs its dependency isolation and promotion.

<a id="model-experience"></a>
## Model Experience

None, as this bundle contributes document preview UI and no model context or Session events.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Native preview supports the existing macOS and Windows targets. Office editing, saving, and recovery are outside this bundle’s preview capability.
- The producer the Office Host plugin starts must speak the frame-forwarding protocol version and handshake capabilities of the receiver this bundle's frame-forwarding package ships.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
