# Template: persistence-release

Use this kind for `docs/persistence-changes/releases/dsh-v<version>.md` and its Chinese sibling. These records reconstruct tagged persistence types for human comparison and format validation. They are observations, not compatibility acknowledgements, and do not participate in the current-source history.

## Frontmatter

```yaml
---
description: "The tagged persistence types and adjacent-release differences recorded here."
kind: persistence-release
---
```

## Sections

1. **Summary:** explain the concrete type differences or lack of differences from the preceding available tag and state the Session writer version when relevant.
2. **Table of Contents:** link the following sections with shared bilingual anchors.
3. **Release evidence:** name the source tag and tagged source paths, then link the preceding record and schema companion with relative paths. Identify reconstruction limits.
4. **Declaration:** include exactly one `yaml persistence-release` block with `schemaVersion: 1`, `tag`, `previous`, `sessionFormatVersion`, and `changes`. Each change names `root`, `before`, and `after`; null represents absence. Both languages contain identical machine blocks.
5. **Structural changes:** list mechanically detected paths and kinds. Current-rule classifications are informational; they do not establish historical release safety or imply that the observed writer version increased.
6. **Verification:** state executed reconstruction and validation evidence. `pnpm run verify-persistence-releases` validates the committed archive without source checkouts, Git, or network access.
7. **Dev Note:** reserve this section for non-authoritative working context, or write `None.`.

## Snapshot and history rules

The [archive reference](../../../../docs/persistence-changes/releases/README.md) owns the pinned release manifest and extraction limits. The first record contains every extracted root; later schema companions contain only changed roots that remain present, with all their reachable type definitions. Empty changes and snapshots preserve releases with unchanged types. Each record references the immediately preceding manifest entry.

The index table, inventory cell, and structural-change facts use `persistence-release-index`, `persistence-release-inventory`, and `persistence-release-changes` start/end comment markers. Keep human explanations outside these generated regions. `pnpm run verify-persistence-releases --write` validates all machine data before refreshing factual regions and pairing records; it preserves authored prose, machine declarations, and schema files. Default verification rejects stale generated facts and missing fixed index files.

Keep source `number` declarations and historical optional fields intact. Report actual writer version constants separately. Historical parsing permits optional `surfaceOp` for surface events; the live persistence parser and acknowledgement rules remain strict. Never insert these retrospective records into the current-source acknowledgement chain or rewrite the committed baseline to accommodate old releases.
