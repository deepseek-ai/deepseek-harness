# Agent Note: Anonymous translation remains separate from model history

Status: implemented

English | [中文](2026-10-05-anonymous-reasoning-translation.zh.md)

## Problem

Readers need reasoning in their chosen language without another model credential or replacement of the original assistant output. Translation needs an owner for external requests, cancellation, and failures independent of Agent execution.

## Decision

The experimental translator owns explicit Google or Bing routing, provider-language normalization, and bounded network requests. Its Service Definition and both providers share one package because their current consumers use the same operation and lifetime. The optional GUI consumer owns settings, paragraph scheduling, per-disclosure caches, and translated display. Its authenticated Remote calls the translator; the agent loop and Session event types remain independent.

Bing is the configured default. Enabling the bundle permits transmission of expanded reasoning to the chosen service, disclosed in plugin metadata and settings. Failure never selects another provider. Original remains available; translated text neither replaces persisted assistant output nor enters model input. The [optional-bundle admission policy](2026-09-21-experimental-capabilities-as-optional-bundles.md) keeps the feature disabled until selected.

The GUI registers a translation wrapper in the standard `conversation.chat.reasoning.body` Slot and calls the official `conversation.chat.reasoning.content` Factory for original or translated text. The default body is also an ordinary registration; the host supplies no inline Markdown fallback or plugin action state. The translation wrapper owns its toolbar and passes its localized labels to the Factory, which supplies default labels when callers omit them and fixes compact typography. The [reasoning Body Slot and Content Factory design](2026-10-09-reasoning-content-slot-factory.md) supersedes this record's body composition mechanism; external requests remain separate from model history. Consumers do not replace the assistant renderer or alter Session projection. Only expanded bodies start translation. Collapsing, changing selection, or unloading aborts outstanding work and excludes late results.

## Alternatives considered

**Translate through the conversation's LLM provider.** This adds model requests and depends on model credentials, pricing, and routing. Anonymous translation has separate availability and requires none of those credentials.

**Rewrite reasoning in the Session or provider stream.** This changes the original trajectory and can affect model reasoning passback. Display translation preserves the original model history.

**Silently try another endpoint after failure.** This sends potentially private text to another operator without an explicit selection. Retry uses the same provider; switching providers is a user action.

## Consequences

Anonymous translation adds no third-party translation library or model-token usage. Anonymous endpoints provide no developer availability guarantee. Both providers send source text in POST request bodies. Translations may alter Markdown or code formatting and do not translate collapsed summaries.

The translator retains Session-bound results under the [shared machine-translation persistence decision](2026-10-05-persistent-machine-translation.md); its stateless calls do not record results.
