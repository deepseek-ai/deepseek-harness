# Template: persistence-format

Use this kind for `docs/persistence-changes/historical-formats/vN.md` and its Chinese sibling. Each record describes one explicitly selected historical Session format checkpoint with complete declared types. It is a format reference, not a release record or compatibility acknowledgement. The checkout writer uses the existing current catalog.

## Frontmatter

```yaml
---
description: "The historical Session format, source checkpoint, and persistence types documented here."
kind: persistence-format
---
```

## Sections

1. **Summary:** identify the format and its distinguishing persisted fields.
2. **Table of Contents:** link subsequent sections with shared bilingual anchors.
3. **Source evidence:** name the tag or PR and enough context to select the source tree. A PR's intermediate tree must not be presented as its final merge or as a product release. Historical sources use file paths without line numbers and remain text unless linked to the exact source.
4. **Format characteristics:** explain header, event, and physical encoding distinctions; link codec owners for behavior beyond the declared-type inventory.
5. **Declaration:** include one identical `yaml persistence-format` block per language with `schemaVersion: 1`, numeric `sessionFormatVersion`, `source` containing exactly one `tag` or numeric `pullRequest`, and a `roots` mapping from every root key to its captured SHA-256 digest. Link the sibling `vN.schema.json`.
6. **Complete schemas:** keep one `persistence-format-schema:start` / `persistence-format-schema:end` comment region. The format verifier renders root digests and all reachable definitions here.
7. **Verification and limitations:** state actual extraction evidence, coverage limits, and the offline verifier. Preserve historical optional fields and opaque declarations without claiming codec admission or migration safety.
8. **Dev Note:** reserve non-authoritative working context, or write `None.`.

The [format index](../../../../docs/persistence-changes/historical-formats/README.md) owns coverage and maintenance. `pnpm run verify-persistence-formats --write` validates schemas before refreshing generated regions and pairing records. It cannot create historical evidence or repair machine data. Keep every older integer documented when the current writer advances; do not duplicate the current catalog under a historical filename.
