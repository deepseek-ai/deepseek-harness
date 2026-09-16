# Agent Note: Model image-input settings

Status: implemented

English | [中文](2026-09-14-model-image-input-settings.zh.md)

## Problem

Models settings can edit a model id without exposing the input capabilities that determine whether image attachments are accepted. A custom vision model can therefore appear in the picker while retaining a text-only declaration.

## Decision

Each model row exposes image input under Model options. Supported declares text and image; Not supported declares text only; Default removes the model's explicit input field. DeepSeek writes `inputModalities`, whose absent value means text only. Pi-ai writes `input`, whose absent or empty value inherits the installed model catalog or provider default. Opening a row preserves that inheritance without materializing an override.

The shared field replaces one drafted row and preserves unrelated metadata. Selecting text only or default for DeepSeek also removes its image request limits, because the adapter rejects those limits without image input. Saving uses the existing catalog-array settings mutation and adapter validation. Configuration declares an upstream capability; it does not add image processing to a text-only model.

## Alternatives considered

**Keep `input` editable only in the settings document.** The [earlier pi-ai modality decision](../../archived/architecture/2026-08-12-pi-ai-route-default-input-modalities.md) kept this field outside the model-list editor. That leaves users who add custom vision models through the UI unable to enable their image input there. Per-row editing supplies that configuration while the default choice preserves catalog inheritance.

**A two-state switch.** Treating an absent pi-ai declaration as disabled would misrepresent inherited vision support and encourage overwriting catalog defaults. The explicit Default choice preserves the adapter's existing resolution rules.

**Keep image limits when disabling DeepSeek images.** This leaves a configuration that the adapter refuses to save. Clearing the image-specific limits makes the selected text-only state valid while preserving unrelated model fields.

## Consequences

Users can configure image input for DeepSeek and custom pi-ai model rows through the same control. Restoring defaults can change effective capabilities when the installed catalog or provider defaults change. DeepSeek image limits must be configured again after disabling images. Provider routing and the [catalog recovery rules](../bug-fix/2026-09-07-pi-ai-settings-catalog-recovery.md) remain owned by their existing decisions.
