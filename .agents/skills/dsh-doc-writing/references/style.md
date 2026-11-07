# Page style

## Summary

Page-level style preferences that make DSH pages scannable and difficult to misread: a short Summary, controlled technical English, `-----` separators between major parts, `<details>` folds that keep section titles visible, and disciplined emphasis. The template is the `session-persistence-jsonl` README pair.

## Table of Contents

- [Short summary](#short-summary)
- [Controlled technical English](#controlled-technical-english)
- [Section separators](#section-separators)
- [Foldable content sections](#foldable-content-sections)
- [Emphasis discipline](#emphasis-discipline)
- [Dev Note](#dev-note)

## Short summary

Open every authored page with a short `Summary`: three to five sentences in one paragraph stating what the reader can do or observe, why the reader cares, the operating model, and the most important boundary. The Table of Contents and the sections carry the detail; placement and section order live in [structure-hierarchy.md](structure-hierarchy.md). An English package README Summary is additionally limited to 100 `wc -w`-style words by `verify-package-readme-summaries`.

## Controlled technical English

Use an [ASD-STE100](https://www.asd-ste100.org/)-inspired review pass for English prose that an agent, translator, or non-native reader must parse. This is a clarity discipline, not certified ASD-STE100 compliance. The repository does not reproduce or validate the standard's controlled dictionary.

- Name the actor and action. Prefer active voice when the actor matters.
- Use one stable term for each concept. Do not rotate synonyms for variety.
- Prefer direct verbs. Replace nominalizations and ambiguous phrasal verbs when a precise verb exists.
- Put one instruction in each sentence. Use a list for three or more steps or conditions.
- Split semicolons and long clause chains. Keep each paragraph on one topic.
- Remove unsupported quality adjectives and stacked hedges. Preserve every fact and degree of uncertainty from the source.

Treat 20 words for an instruction and 25 words for a description as review prompts, not mechanical gates. Keep a longer sentence when a split would hide a condition or relationship. Never remove or strengthen `must`, `may`, `never`, timing, exceptions, numbers, or other contract terms to meet a length target. The [prose standard](../../dsh-prose-standard/SKILL.md) owns the complete-proposition rule.

## Section separators

Separate the major parts of a page with a `-----` horizontal rule on its own line, with a blank line before and after it. A rule directly after a paragraph would parse as a Setext heading, and a rule inside the final two H2 sections of a package README would break the Model Experience gate. The template separates: front matter → use section → folded developer section → Further Exploration → Model Experience.

## Foldable content sections

Fold developer-facing detail and the final Dev Note behind GitHub-native `<details>`/`<summary>` blocks. Keep the section title (H2 or H3) and its `<a id>` anchor visible; fold only the content under the title. Inside the block, put a blank line after `<summary>`, keep every Markdown line at column 0 (indented content becomes a code block), and close with `</details>` after a blank line. Headings, lists, tables, and links inside the fold parse normally and keep their anchors. The `session-persistence-jsonl` README pair demonstrates both folds: the implementation section and the Dev Note.

In a package README, keep `## Model Experience` and `## Known Limitations and Deferred Work` as the final two H2 headings. Put the limitations anchor immediately after its H2 so it does not become part of the preceding Model Experience body. Place the final Dev Note under the limitations section as an anchored H3. A package that is explicitly exempt from the limitations section can use an H2 Dev Note.

## Emphasis discipline

Reserve bold for the clause that changes behavior or for the comparison that matters. In benchmark tables, bold the column headers and the best value in each row, as in the reference example.

## Dev Note

None.
