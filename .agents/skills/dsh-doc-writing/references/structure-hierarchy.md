# Page structure and hierarchy

## Summary

Each page gives a newcomer a short front door before it exposes operational or implementation depth. Cross-package learning and engineering material lives under a deliberate `docs/` hierarchy, while package contracts stay beside code. Small rule files own one independently searchable requirement, but arbitrary fragmentation is not a goal. The final Dev Note isolates active working context from the stable explanation above it.

## Table of Contents

- [Page order](#page-order)
- [Section progression](#section-progression)
- [Documentation hierarchy](#documentation-hierarchy)
- [Small rule files](#small-rule-files)
- [Further Exploration](#further-exploration)
- [Dev Note ownership](#dev-note-ownership)
- [Dev Note](#dev-note)

## Page order

Use this order for authored human-facing pages when the format owner permits it. Generated artifacts may generate the same entry sections, while Agent Notes and postmortems retain their repository-defined skeletons.

1. YAML metadata.
2. H1 title.
3. Language switcher for a bilingual page.
4. `## Summary`: three to five explanatory sentences stating what the reader can do or observe, why a reader would care, the main operating model, and the most important boundary. English package README Summaries stay within the gate-owned 100-word limit.
5. `## Table of Contents`: links to the page's H2 sections; keep it navigational rather than descriptive.
6. Stable content, ordered from user-facing use to developer-facing design and operational detail.
7. Optional `## Further Exploration` for newcomer-oriented links to adjacent subjects.
8. Final `## Dev Note` for non-authoritative active working context.

Do not force a Summary/Table of Contents wrapper around tiny machine-owned files, generated fragments, or formats whose executed parser defines another header. State the exception in the format owner rather than creating invalid output. The package README gate requires `Model Experience` and `Known Limitations and Deferred Work` as the final two H2 sections: place `Further Exploration` before them and end with a final `### Dev Note` inside the limitations H2.

## Section progression

Open every substantive H2 with a short orienting paragraph before tables, code, or H3 subsections. Explain the section's subject and decision-relevant point; do not repeat its complete contents.

Within a page, order content by reader depth:

1. Basic use: when to choose the feature, required inputs, shortest safe example, observable success, and likely recovery.
2. Advanced use: configuration choices, limits, operations, and integration behavior.
3. Developer detail: ownership, lifecycle, data model, failures, performance, security, and extension points worth maintaining.

Fold heavy developer detail and the final Dev Note behind `<details>` blocks with the section titles visible (mechanics in [style.md](style.md)).

Folded developer detail is concept-level by requirement: the overall design concept, the architecture of the main components, and hand-waving dataflow — enough to understand how the package works — plus source-map tables and links to code for exact detail. It never becomes an exhaustive catalog: no full API inventories, column lists, event-payload enumerations, or JSDoc restatement. The Dev Note is the only place allowed to hold partial ideas, scratches, and undecided directions; everything else, folds included, is polished current-state prose.

Keep exhaustive generated types, schemas, or catalogs behind a compact entry paragraph and stable index. Split them by an existing domain owner when one lookup requires scanning unrelated groups.

## Documentation hierarchy

Use package-local READMEs for package contracts and keep them next to source. Organize cross-package Markdown under audience and learning intent instead of leaving unrelated pages flat at `docs/`.

```text
docs/
  learn/
    overview/
    cordis/
    practices/
  user/
  developer/
    discussion/
  scratch/
  subsystems/
```

Treat this as a target map, not permission for an opportunistic mass move. Move one coherent topic at a time, repair every inbound link and website mapping atomically, preserve public routes or aliases, and keep `subsystems/` flat because its pages are logically parallel.

`docs/scratch/` contains tracked, expiring discussion that must survive a handoff. Each scratch page names its owner, creation date, expiry, and promotion target. Local disposable notes remain ignored and uncommitted.

## Small rule files

Give an independently searchable rule, practice, example family, or decision one small file when it has its own owner, change cadence, inbound links, or validation. Group related files under a descriptive hierarchy such as `docs/developer/code-quality/`. Keep tightly coupled rules together when splitting would force readers to open several files to understand one obligation.

An index page explains the folder in three to five sentences and links its direct children by purpose. It does not restate each child's rule.

## Further Exploration

Use this optional section for a newcomer who finished the page and wants adjacent understanding. Link three to seven directly related pages, order them from closest prerequisite to deeper exploration, and say in a short phrase what each adds. Do not turn it into a complete site index.

## Dev Note ownership

End authored pages with Dev Note, but keep it explicitly non-authoritative. Active hypotheses, compatibility concerns, rough alternatives, progress pointers, and unresolved questions may live there; stable behavior, required limitations, and accepted rationale belong in their ordinary owners.

Dev Note may mirror or link task progress but must not become a second writable queue. When work closes, promote durable conclusions, move reusable rationale to an Agent Note, keep incident chronology in a postmortem, and delete resolved chatter. Git history preserves old iterations.

## Dev Note

The mandatory final section is intentionally the least polished part of an authored page, but it still has lifecycle discipline. A blank Dev Note should say `None.` rather than accumulate placeholder prose; generated and parser-owned formats may omit it through a named exception.
