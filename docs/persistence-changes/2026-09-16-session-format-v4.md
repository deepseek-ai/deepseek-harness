---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-16-session-format-v4

English | [中文](2026-09-16-session-format-v4.zh.md)

## Summary

Advances the declared SessionHeader.version from 3 to 4 for the finalized V4 writer, records first-class tool-role results and producer-owned sources, and adds the forked variant to turn/end.reason. Adds developer-role Session changes with name-only tool additions bound to historical request headers, tool removals, and deferred-loading schema markers.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-16-session-format-v4
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-11-initial"
    after: "1a3440e3577382704d42a6263aa463504eb74c566734a55e9503a63efcd02445"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-14-image-offload"
    after: "1506a9b8224986c83015ae99d2cb5ede705538c58c063d6a48ef6d761a31ba6c"
    decision: version-bump
  - root: "event:assistant/attempt"
    previous: "2026-09-14-image-offload"
    after: "15d5dfdd822aa35e115afd74a8982825a493880457774e6850bc1520b50875e4"
    decision: version-bump
  - root: "event:assistant/message"
    previous: "2026-09-14-image-offload"
    after: "1033093edd0db80ff410e00830b523405e00bb0c7684948e531ff65095799625"
    decision: version-bump
  - root: "event:compaction/summary"
    previous: "2026-09-14-image-offload"
    after: "e2f9a41e0989f54ed8cee80f8db2bcf9d60a5c810dc9d45b83fa050b9dce7602"
    decision: version-bump
  - root: "event:developer/message"
    previous: null
    after: "eef4ef54dc7a133d47448a4ee822e45a351314923ef5f66db34c8b24e4b32d80"
    decision: version-bump
  - root: "event:request/header"
    previous: "2026-09-11-initial"
    after: "4208123b50df5006b181481ab45fcf1cde807b88d3fd4d340090bc2e202fac41"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-14-image-offload"
    after: "fa8f7d3ebf08a76c7f7a8b0781873c4d819b964da5dbb52cd3cdfa5da34f452d"
    decision: version-bump
  - root: "event:system/message"
    previous: "2026-09-14-image-offload"
    after: "69081694be231d56fd9580ba14645fd5e35373202605d5c5c841a9435b5fa3b1"
    decision: version-bump
  - root: "event:team/message/queued"
    previous: "2026-09-14-image-offload"
    after: "21fb6a90d5068f6a0003b7ab316ed2f56342477146a65c00db0f13c4d8df667d"
    decision: version-bump
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-14-image-offload"
    after: "100f6dca1468538239522cde3533e5bd721d0f1a7b50bea8b0eb533ea6c96163"
    decision: version-bump
  - root: "event:tool/result"
    previous: "2026-09-14-image-offload"
    after: "7c9f44e90a0058f4cc532ae20dad0c10afa6eba22e70a6c79fc79490bad64397"
    decision: version-bump
  - root: "event:turn/end"
    previous: "2026-09-14-image-offload"
    after: "0f8512903d94f57a4748fa1a2092e64342856796684e6b8343db685b192745ce"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-14-image-offload"
    after: "3f72db3d87a0c5c43e68be467b4cca728eaf5adc1d5d2b6975ff42bfbd961761"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

The tool-role declaration changes ten event roots because inbox entries, message events, compaction summaries, title requests, team messages, and PTC dispatches embed the shared `Message` or `ContentBlock` declarations. Removing `tool-result` from that union and specializing message roles changes those reachable schemas without adding ten independent event protocols. The `turn/end` change separately records the forked reason; `SessionHeader` records the version increase.

The [native V4 validation decision](../../.agents/notes/implemented/architecture/2026-09-17-native-v4-read-validation.md) owns the reader admission required by these current fields.

The V3-to-V4 migration lifts released user-role tool results into tool-role messages with a required toolCallId and optional isError. Tool-result wrappers leave the content-block union. The migration preserves every admitted source event and inherited cut, and appends missing parent subagent/catalog records from retained direct-child logs in the same persistence root. Historical body restoration requires an explicit child-evidence set, including an empty set when no children are available to backfill. Missing, multiple, or unknown-version child descriptors skip that child’s backfill; conflicting identities, timestamps, or modes refuse migration without publication. Existing catalog facts remain. Historical read opens prepare the result in memory. Write opens revalidate child membership and revisions before publishing the current successor beside unchanged predecessor files. Delivery-generation checks keep historical acknowledgements from becoming active V4 watermarks. V3 readers refuse the newer generation. The finalized transition adds forked to turn/end.reason; exact-cut forks append child-owned error results and closers after the inherited marker. V4 admits checked not-started fork results with deterministic branch-specific IDs and wording; released V0–V3 validators and recorded predecessor generations remain unchanged.

The `request/header` schema also records the retired `system` key as forbidden. This declaration captures the existing native-reader refusal without changing stored data or prompt reconstruction; later permitting a value requires a version bump instead of being classified as an ordinary optional-field addition.

Producer-owned sources replace released plugin wrappers through the [V3-to-V4 migration](../../packages/session/session-format-v3-to-v4/README.md#v3-to-v4-specification). The frozen rename table and collision rules preserve source fields and event coordinates; unknown producer attribution retains every own JSON property. Native read and write opens validate source fields before exposing the Session. Existing V4 files do not rerun the incoming migration edge.

The core-owned user source property records the attribution-preservation policy; tmux-context qualifies its location attribution while retaining producer-local duplicate suppression. Auto Review and the compaction summarizer use request-only user inputs, removing their active source registrations without removing historical migration support. These inputs cannot be written as durable Session messages. Catalog formatVersion 2 stores the policy metadata; it does not change the Session version or rewrite frozen schema records. System, model, and tool sources retain their strict semantic rules.

Developer events retain their original role and require an open step. Each addition stores toolName; developer/message.headerSeq identifies an earlier known request/header containing exactly one complete matching ToolSchema. All additions in one event share that historical header revision, while removal-only and other developer messages omit headerSeq. Native and Session admission reject absent, forward, non-header, unknown-header, ambiguous, incomplete-definition and retired inline-definition forms without interpreting unknown ignorable records or dropping unrelated JSON metadata. Same-name replacement, restart, fork, surface replacement and compaction retain historical schema identity without consulting the latest header or registry. Generic sourceEventSeqs remains independent. Developer sources use the same recorded attribution-preservation policy as user sources. The optional deferLoading marker is independent of addition history. No shipped profile emits developer records; provider serialization, automatic emission and UI support remain deferred.

The PTC producer writes `source.kind: 'ptc-mode'`. The V3-to-V4 edge retains `tools-code-mode` and `tools-ptc` as historical plugin lookup keys and maps both to that current kind. The source policy reserves `ptc-mode` against attribution-only qualification.

<a id="verification"></a>
## Verification

The focused Session, agent-loop, Session Controller, V4, chat-view, and compaction suites passed 1,523 tests across 63 files after integration of exact-cut forks. V4 fork tests retain original IDs and text across encoding, decoding, and restoration, reject malformed results, and validate nested inherited cuts. The tool-role migration tests and SDK snapshot refresh also passed in the originating change; the built Python runtime sdk-snapshot scenario passed, and focused pi-ai and auto-review coverage passed 351 tests with 100% coverage of the three affected modules.

The generated request-header reservation regression and existing retired-syntax and Session surface tests pass 65 tests across three files. The generated field retains optional `never`; permitting an optional string produces a version-bump diagnostic while the native reader still refuses the retired key.

The producer-source and request-input checks pass 447 tests across 12 files, including provider equality, request-only type rejection, user-attribution retention, source migration, and native source admission. Comparing the generated inventories with the tool-role parent reports four changed roots and 447 unchanged type fingerprints.

The focused Session, V4 and request-input suite passes 884 tests across 38 files, with 100% statements, branches, functions and lines for the complete V3-to-V4 package and Session surface. Coverage includes historical same-name schema binding, compound additions/removals, malformed references and definitions, unknown-header refusal, opaque unknown records, metadata preservation, forks, replacements, compaction references, and native plain/zstd read/write admission without rewriting the generation.

<a id="dev-note"></a>
## Dev Note

None.
