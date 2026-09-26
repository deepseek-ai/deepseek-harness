# Agent Note: Unified model input controls

Status: implemented

English | [中文](2026-09-16-unified-model-input-controls.zh.md)

## Problem

Separate DeepSeek and pi-ai row renderers let labels, icons, and spacing diverge. An automatic column count moves image input between the capacity row and a second row with small width changes. The image-support selector also cannot express image-only input, although both adapters accept it.

## Decision

Both catalogs render a shared model row. The two capacity fields occupy two columns, and Input types occupies the full next row. Text and Image use the controlled native Checkbox in `ui-primitives`, with caller-owned localized labels and native keyboard behavior. At least one type remains selected; the last checked type is disabled until another is selected.

An undeclared or empty input field displays the installed model input types, then the route default, then Text, without materializing an override on open. Pi-ai catalog discovery carries optional `inputModalities` through the LLM service and Remote response; adopted candidates copy it to `input`. Known provider editors read the installed catalog without endpoint I/O, so existing capacity-only rows also display inherited vision support. Catalog reads for a previous provider are discarded, and input controls wait for the current read to settle. The first checkbox edit writes the exact nonempty selection to DeepSeek's `inputModalities` or pi-ai's `input`. Existing explicit selections, including image-only input, remain visible. Unrelated metadata survives edits; disabling DeepSeek images removes its image request limits because the adapter rejects those limits without image input. Saving uses the existing catalog-array mutation and adapter validation.

## Alternatives considered

**Independent model-row renderers.** Adapter-specific defaults and model discovery remain with their editors, but duplicate presentation creates avoidable visual drift. Shared rows keep those behaviors independent of field layout.

**Keep the image-support selector.** Settings-file-only capability editing leaves custom vision models effectively text-only. A selector with an explicit Default option preserves visible pi-ai catalog inheritance; a two-state image switch would misrepresent inherited vision support as disabled. The checkbox interface exposes both input types directly, resolving inherited capabilities before enabling edits. Merely opening a row still preserves inheritance; restoring it after a checkbox edit requires removing the input field in settings or resetting the catalog override.

**Allow no checked types.** DeepSeek rejects an empty list and pi-ai treats it as inheritance. Keeping a nonempty selection prevents the same gesture from meaning different things across adapters.

**Keep image limits when disabling DeepSeek images.** This leaves a configuration that the adapter refuses to save. Clearing the image-specific limits makes the selected text-only state valid while preserving unrelated model fields.

## Consequences

Users can edit text-only, image-only, and combined declarations through one layout. Configuration declares upstream capabilities; it does not add image processing to a text-only model. Removing a pi-ai input declaration can change effective capabilities as catalog or provider defaults change. DeepSeek image limits need reconfiguration after images are disabled. Provider routing and [catalog recovery](../bug-fix/2026-09-07-pi-ai-settings-catalog-recovery.md) retain their existing owners. Component checks cover defaults, exact selections, metadata preservation, and disabled controls; browser scenarios cover saved adapter capabilities, reopened selections, the separate input-type row, and installed vision metadata across discovery, adoption, and reopening.
