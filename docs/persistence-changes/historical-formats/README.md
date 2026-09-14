---
description: "Find the complete declared persistence types for every Session format from V0 through the checkout writer."
---

# Session persistence formats

English | [中文](README.zh.md)

## Summary

Use this reference to inspect a stored Session generation’s headers, event envelopes, and payload types. Every format below the checkout writer has a bilingual document and a complete schema snapshot. The current format uses the generated persistence catalog. The [version authority](../../session-format-status.md) owns the writer constant and release status.

## Table of Contents

- [Format references](#formats)
- [Scope and evidence](#scope)
- [Maintain coverage](#maintenance)
- [Dev Note](#dev-note)

-----

<a id="formats"></a>
## Format references

The index is generated from validated snapshots and the current writer constant. Each historical reference identifies its source checkpoint; a Session format number does not identify every event payload revision within that format.

<!-- persistence-format-index:start -->

| Format | Source | Reference | Machine schema | Roots / types |
|---|---|---|---|---|
| 0 | `dsh-v0.1.2-rc.1` | [V0](v0.md) | [JSON](v0.schema.json) | 54 / 415 |
| 1 | PR #3349 | [V1](v1.md) | [JSON](v1.schema.json) | 54 / 415 |
| 2 | `dsh-v0.1.3-alpha.2` | [V2](v2.md) | [JSON](v2.schema.json) | 56 / 435 |
| 3 | Current checkout | [Current catalog](../../persistence-catalog.md) | [JSON](../../persistence-schema.json) | 60 / 468 |

<!-- persistence-format-index:end -->

<a id="scope"></a>
## Scope and evidence

Each `vN.md` / `vN.zh.md` pair has `kind: persistence-format`, an identical `yaml persistence-format` declaration binding every root key to its captured digest, a pairing sidecar, and a complete `vN.schema.json`. The [template](../../../.agents/skills/dsh-doc/templates/persistence-format.md) defines these records. Roots cover the logical Session header, physical JSONL header, event envelope, and all first-party events at the selected checkpoint; each root includes every reachable declared type. Packed physical body records have separate codec owners linked from each page.

V0 and V2 use the latest matching tags in the [captured prerelease archive](../releases/README.md). V1 uses an intermediate source tree identified in its reference because the captured tags contain no V1 writer. Historical sources retain file paths without line numbers. Snapshots preserve historical optional fields and opaque values; they do not substitute current types into older formats. Historical identifiers remain intact only in schema JSON and the verified generated schema regions; authored prose follows current terminology rules.

These references describe selected schemas, not historical application replay or migration safety. Same-version event additions and optional payload changes can produce other valid inventories. The prerelease archive retains tag-by-tag differences; [change records](../README.md) retain current compatibility acknowledgements. Neither history is replaced by these format snapshots.

<a id="maintenance"></a>
## Maintain coverage

`verify-persistence-formats` derives the required integer range from `SESSION_FORMAT_VERSION`. Every older integer needs its own complete record. The current catalog and schema must exist and match the writer version. The check rejects missing, extra, misnumbered, incomplete, or inconsistent records and stale generated regions without fetching Git history or querying a service.

Before advancing the writer, verify the current catalog and archive the outgoing format. For a V3-to-V4 change, run these commands while the writer and current schema still describe V3:

```sh
pnpm run verify-persistence-catalog
pnpm run verify-persistence-formats --archive 3
```

Replace `3` with the outgoing writer version for other transitions. `--archive N` creates `vN.schema.json` from the current inventory, retains exactly the types reachable from its roots, and removes source line numbers. It refuses an existing destination, a version other than the current writer, invalid or incomplete schemas, and combination with `--write`. Add the snapshot’s bilingual record and source evidence using the [template](../../../.agents/skills/dsh-doc/templates/persistence-format.md). Retain all earlier records. The successor uses the current catalog; copying a new current catalog cannot satisfy the archived predecessor requirement. Follow the [format-version cookbook](../../cookbook/adding-a-session-format-version.md) for runtime changes.

The schema definitions and index inside comment markers are generated. After advancing the writer and completing the machine data and authored evidence, refresh their tables and pairing records, then verify:

```sh
pnpm run verify-persistence-formats --write
pnpm run verify-persistence-formats
pnpm run doc-sync
```

`--write` validates the machine data before updating generated Markdown and pairing records. It preserves authored explanations, machine declarations, and schemas. Default verification also rejects stale pairing records; the standard documentation checks validate translations and local links. Current catalog freshness remains owned by `verify-persistence-catalog`.

<a id="dev-note"></a>
## Dev Note

None.
