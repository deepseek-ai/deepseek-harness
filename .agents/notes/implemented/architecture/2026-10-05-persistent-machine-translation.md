# Agent Note: Machine translation results use shared Session records

Status: implemented

English | [中文](2026-10-05-persistent-machine-translation.zh.md)

## Problem

Readers need a saved translation when they reopen reasoning or restart the application. A disclosure-only cache repeats external requests, can change an already displayed result and can incur repeated model charges. Storing only model inputs leaves successful translations unavailable after restart.

## Decision

The translator owns `plugin:translator/request` and `plugin:translator/result` for every provider. A request records its selected provider, exact source text, source and target languages, and recipe identity. Optional metadata carries provider-owned request details. A result references the request's Session sequence and retains the completed translated text. Requests are durable before dispatch, and results are durable before they return to the GUI.

The browser binds displayed translations to the disclosure's Session, and the Host validates the configured provider and explicit target language. The authenticated Client supplies the original text and Session identity; the Host does not verify that the text belongs to that Session. Successful records are reusable across disclosure lifetimes and restarts. Identity includes the provider and recipe, so changing the receiver, language or translation settings cannot substitute another result. Identical concurrent translations wait for one result; distinct fragments can run in parallel.

Read-only lookup precedes provider work. New records use the active Session's existing writer through `appendPluginRecord` and targeted flush. An uncached inactive Session rejects before provider work; the GUI consumer joins normal Session controller activation and retries once.

These records accompany the [original reasoning](2026-10-05-anonymous-reasoning-translation.md) and never replace its events or model input. They use the existing experimental record writer and best-effort format-migration retention. Provider availability gates new requests; a saved result remains readable without another inference. Stateless translator calls remain available without a Session.

## Alternatives considered

**Keep only disclosure-local results.** Reopening loses the displayed value and sends the same text again, with possible repeat charges.

**Give anonymous and model translations different result formats.** The reader needs the same source-to-translation relationship from every provider. Provider-owned audit details belong in optional metadata.

**Replace original assistant reasoning.** A translation is derived data. Keeping it alongside the original preserves model history and access to the source.

**Open a separate writer for historical translations.** This competes with normal Session activation and requires coordination between two writer owners. The GUI already activates opened conversations; using its existing controller keeps that ownership in one place.

## Consequences

The Session retains translated text and request identity in addition to original reasoning. Only completed persisted results supply cached text; failed or incomplete attempts do not. A completion that has already entered the append-only log may survive a late caller cancellation. Records do not introduce released Session schema history, and future format migrations may drop experimental state.

Saved results remain readable without activation. A new translation may wait for normal Session activation, including preset startup hooks, resume markers, interrupted-turn repair, and any required generation migration. These ordinary lifecycle effects can append context; translation does not bypass them. Cache reads leave older generations unpublished. The translator owns no second writer and requires no core lifecycle changes.
