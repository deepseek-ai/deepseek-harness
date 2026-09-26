# Agent Note: Section-keyed translation pairing records

Status: implemented

English | [中文](2026-09-23-section-keyed-translation-pairing-records.zh.md)

## Problem

A consistency record held the full blob hash of each language file. Any edit to a pair changed both lines, so two branches that edited different parts of the same pair always conflicted on the record, even when Git merged both Markdown files cleanly. Generated references such as `docs/config-catalog.md`, `docs/module-graph.md`, and `docs/event-producer-consumer.md` were affected most: most PRs that touch packages, config, or events regenerate one of them, and each regeneration also required a hand-copied Chinese update and a new record. A worktree-local merge driver composed such records, but GitHub's mergeability check never runs it, so PRs still showed a conflict until someone merged the base locally and pushed.

## Decision

`foo.i18n.yaml` holds one entry per heading section that contains hashed content. `verify-translation-pairing` computes the entries; `scripts/translation-pairing-record.ts` owns the format.

- Both sides are split at every heading. Section `i` of the English file corresponds to section `i` of the Chinese file; different heading counts are a structure error and cannot be recorded.
- The key is the English heading-slug path, such as `/plugin-config-catalog/loadable-plugins-with-no-config`. Text before the first heading is `/`, and a repeated path gets `~2`, `~3`, and so on. Keys are counted over every section, including sections without entries, so a key depends only on headings.
- Each side's hash covers the section's top-level blocks after paired-document link localization, except fenced code blocks and generated regions. Those two kinds of content are exactly what the pairing gate already requires to be identical on both sides; any other content is hashed even when it happens to be identical. The entry holds a 16-hex SHA-256 prefix of each side's hashed blocks. A section with no hashed blocks has no entry.
- Each entry spans three lines: an unchanged key line followed by the `en:` and `zh:` hash lines. The key line separates neighboring entries, so Git's text merge treats changes to adjacent entries as separate hunks.

A record conflict therefore requires both branches to change hashed content in the same section.

Generators put their generated data in generated regions and write each region into both pages, so regeneration changes neither the record nor the Chinese prose. `gen-config-catalog` writes both languages and the record, with one region per package and one per package table; labels inside a region are the code identifiers `inject`, `refs`, `source`, and `class`, which the translated introduction explains. `gen-module-graph` keeps its table in a region with identifier column headers. `gen-doc-graphs` splices the event matrix tables into the authored Chinese page, and `gen-cordis-catalog` already did the same for subsystem regions.

`gen-translation-brief` recovers the last-confirmed text from the newest commit of the pair whose contents produce the committed record. Records no longer point to Git blobs, and `--write` no longer stores snapshot objects or refs.

Archived Agent Notes keep their sealed whole-file records; `verify-archived-agent-notes` owns that format.

## Alternatives considered

**Keep whole-file hashes and the merge driver.** The driver resolved the conflict only in local worktrees where it was installed. GitHub still reported the PR as conflicted, raw merges without the installed runtime stopped, and the driver, resolver, installer integration, and their tests were about 1,400 lines of code to maintain.

**One entry per top-level block instead of per heading section.** Fewer false conflicts inside long sections, but the record would grow to roughly the block count of the document. Positional block keys would also renumber on every insertion and create conflicts of their own.

**Positional section keys (`h2[3]`).** Inserting a section renumbers every later key and changes every later record line, which recreates the conflicts this format removes. Heading-slug keys change only when that heading's English text changes.

**Resolve on GitHub through Actions or an app.** Hosted automation would need credentials, concurrency control, and permission to rewrite PR branches. A record that Git's default text merge composes needs none of these.

**Hash whole sections, including code blocks and regions.** Every regenerated row or code block would still change a record line, so generated references would keep conflicting on their largest sections.

**Leave out any block that is byte-identical on both sides.** It also keeps generated rows out of the record, but it decides implicitly what needs no translation: an English paragraph copied untranslated into the Chinese file would be left out too, and a later edit to it would no longer change the record. Code blocks and generated regions are declared shared content that existing gates check.

## Consequences

Edits to different sections, and regenerated regions and code blocks, merge without a local tool, including on GitHub. Replaying the merge commits reachable from `master` between 2026-08-20 and 2026-09-23 shows the effect on real history: see [Measured effect](#measured-effect).

A same-section conflict is resolved by resolving the Markdown and re-running `verify-translation-pairing --write <pair>`; no command automates it. Chinese readers of generated regions see code identifiers and English table headers instead of translated labels. Recovering last-confirmed text for the brief requires the confirmed pair to be committed.

## Measured effect

The replay covered 2016 two-parent merge commits reachable from `master` between 2026-08-20 and 2026-09-23, most of them PR branches merging the base forward. For every active pair whose record both parents changed, it ran Git's default text merge on the old record, on the section-keyed record computed from the same commit contents, and on the two Markdown files. It counts a record whose headings did not align at some commit as a conflict. The old format conflicted in 2950 pair merges across 850 merge commits; the section-keyed format conflicts in 1586 pair merges across 595 merge commits, a 46% reduction per pair. The Markdown files themselves conflicted in 926 pair merges across 338 merge commits, which no record format can avoid. Merge commits whose only conflicts were records fell from 512 to 257 (50%).

The replay uses each commit's content as it was, before the generators wrapped their data in regions, so `docs/module-graph.md` (277 conflicts), `docs/event-producer-consumer.md` (220), and `docs/config-catalog.md` (110) still conflict on generated data in it. With that data in regions, their records change only when their prose changes; excluding their generated rows from the same replay left 0 and 14 conflicts for the first two. Substituting that for the three pages projects about 990 pair conflicts, about 66% below the old format; this projection is an estimate, not a replayed measurement.

## Related

The [bilingual pairing gate Agent Note](2026-07-02-bilingual-docs-and-pairing-gate.md) owns the three-file pair and its equal-authority rule; this note replaces its whole-file hash record. The [archived automatic pairing merges Agent Note](../../archived/process/2026-08-08-automatic-translation-pairing-merges.md) records the retired merge driver.
