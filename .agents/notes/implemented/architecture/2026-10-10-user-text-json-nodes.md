# Agent Note: User-text candidate scheduling and Facts-driven refresh

Status: implemented

English | [中文](<2026-10-10-user-text-json-nodes.zh.md>)

## Problem

User text contains references owned by independent businesses. Recognition must follow original-text positions, resolve collisions deterministically, and reuse unaffected matching work when Facts change. The evaluator must expose its scheduling behavior to pure logic tests without depending on React, browser timing, or elapsed-time benchmarks.

## Decision

The composition is business registration, lazy candidate matching, a single reconciliation loop, readonly JSON nodes, and business-owned keyed renderers. Initialization and Facts refresh use the same algorithm; they differ only in which query caches remain valid.

### Rule roles and original coordinates

Every rule provides an ID, finite order, and synchronous `match(text, from, context)`. Each call returns its nearest eligible node with `start >= from`, or no candidate anywhere in the remaining original text. It returns one node, not all matches or a replacement document. The original string and UTF-16 offsets remain intact: a search cursor does not create a new word, line, or quoted-token boundary. Matching depends only on original text and Facts, not previously selected node payloads.

Each matcher resolves its own alternative spellings by earliest start and then its documented same-start choice; Session labels choose the longer match. A matcher cannot replace a consumed prefix with the remainder of an overlapping candidate. Each business owns its grammar, payload, and renderer; the generic evaluator has no Session, file, skill, or command branches.

There is one rule type and one candidate protocol. A candidate contains either a business node using the rule ID or a Text node preserving the original substring with an optional `data.display`. Text-producing rules compete by the same start, order, and stable ID as business rules. Order only breaks same-start ties; no rule gets precedence over an earlier position.

### One reconciliation loop

The evaluator keeps original text, the previous successful segmentation, registered definitions, per-rule Facts reads, and query results. Nonempty text initially has one Text covering `[0, text.length)`; empty text has no nodes. Initialization makes every rule invalid, including rules that read no Facts.

Each reconciliation starts its result cursor at zero. Every matcher obtains one candidate through the same cache-aware query operation. The evaluator selects the smallest candidate start, breaks same-start ties by ascending rule order and stable ID, emits the preceding raw Text gap, emits the winner, and advances the cursor to the winner's end. No candidate means the remaining raw text is emitted and recognition ends.

Only a consumed candidate or a candidate whose start is before the new cursor needs another query. A cached candidate beginning at or after the cursor remains eligible. A no-candidate result remains eligible as the cursor advances. All ranges are nonempty half-open original-text ranges; candidates cannot move the cursor backward or exceed the original string.

Previously accepted nodes are reusable output, not a complete list of possible matches: a losing candidate can become visible when an earlier winner disappears. The evaluator retains queries for this purpose instead of treating an old Text node or the absence of a business node as unconditional evidence of no match.

### Query cache and traversal

A query record contains its original `from` offset and either the next candidate, no candidate, or a failure. If a query from `q` returned a candidate starting at `s`, its result is valid for any requested cursor `c` with `q <= c <= s`. A no-candidate result is valid for every `c >= q`. Neither result proves anything before `q`. A failed query is reusable only at the same requested offset while its dependencies remain valid.

During a reconciliation, each matcher has one active candidate. The evaluator also retains the sorted query records already produced for that matcher across reconciliations; it does not enumerate all possible matches eagerly. Forward cursors walk these records monotonically. Queries generated in newly exposed gaps are merged with retained records in source order, with one record per query offset. Unsearched intervals require matching rather than an invented negative result.

The result cursor and matcher search cursors are distinct. Starting result reconciliation at zero does not require unchanged matchers to scan from zero again: their recorded queries answer valid requests. Each matcher must implement a forward search rather than repeatedly materializing every match in the remaining text. Internal scans, candidate selection, and result comparison still have costs; the scheduling guarantees concern actual matcher calls, not a claim that arbitrary regular expressions are linear.

### Actual Facts dependencies

`context.read(key)` returns the borrowed readonly value from the current Facts snapshot and records the read, including `undefined`. The reader is valid only during its owning synchronous call and cannot be retained. Businesses receive neither a whole Facts object, a manual `dependsOn` list, nor previous-output/cache objects.

A matcher's dependency set is the union of reads for the queries retained in its current cache generation, including losing candidates, no-match queries, and failed calls. Changed fields are detected with `Object.is` at field granularity. A new outer Facts object alone does not invalidate matching. When a rule is invalidated, its old queries and read set are discarded; subsequent calls establish the replacement read set, so obsolete conditional dependencies do not remain permanently attached.

Text-producing rules use the same query cache and dependency generation as every other rule. Updating a whitespace switch invalidates only its readers; it does not trigger an unconditional pass over the completed nodes.

### Facts, text, and registration refresh

A Facts update invalidates only rules that read changed fields. Their first query starts at original offset zero; all other rules retain their query records. The same reconciliation loop then compares fresh candidates with reusable ones. Refreshing a rule does not give it priority, and a new first candidate does not hide the removal of an earlier old winner.

A fresh candidate confined to previously plain text can split that Text without invoking unrelated matchers whose cached queries still cover the new cursors. A fresh candidate that loses to an earlier unchanged winner is discarded without invalidating that winner. When a fresh winner covers another candidate, only expired heads advance. When a winner disappears or shrinks, cached losing candidates can compete again; any previously unsearched interval causes a query at the newly exposed cursor. All changes use the same cursor loop and query-coverage rules.

Several changed Facts fields form one snapshot and one invalidation set. All affected matchers participate in the same reconciliation; one update is not committed before processing the next. Equivalent refreshed results reuse previous nodes and, when all elements remain identical, the entire result array. Reconciliation settles the complete document before publishing its result.

Original-text changes discard all query caches and supply one full-range Text as the previous segmentation. New or replaced rule definitions start with empty caches; unchanged definitions retain their independent queries. Removed rules lose their dependencies and candidates. Reconciliation after additions, removals, or order changes uses the same selection logic and can expose formerly blocked candidates.

### Output, ownership, and publication

Nodes retain `{ id, start, end, data }`. Business nodes use their matcher's ID; Text retains the exact source substring in `data.text` and optional display text in `data.display`. Output is ordered, nonoverlapping, and completely covers the original text. JSON compatibility and readonly ownership are TypeScript obligations: the evaluator neither freezes borrowed objects nor deep-copies Facts or payloads for isolation.

The document evaluator owns all caches; the registry retains neither evaluators nor document subscriptions. Separate text instances do not share state through a global cache. Only fully successful evaluation publishes a new result. A matcher failure carries the rule ID and cause and publishes no partial segmentation; its actual reads remain available for dependency-driven retry. Reentrant evaluation and escaped synchronous read contexts are rejected.

`conversation.user.text` remains a session-scoped Factory owning `conversation.user.text.node`, a keyed inline Slot. React consumes final nodes and forwards `raw` and `interactive` to the business renderer. Session, skill, file/folder, and command matching remain owned by their respective plugins, and actions remain in each renderer's Injection. No matching work or cache subscription moves into React.

`collapseWhitespace` and `trimWhitespace` each control one ordinary matcher and default to off. Collapse offers whitespace runs as Text candidates with display `" "`; trim offers original leading/trailing whitespace runs with display `""`. Trim has lower order than collapse, so it wins their same-start edge collisions. An earlier reference candidate consumes its whole range and naturally excludes internal whitespace candidates. Every Text candidate retains its exact raw substring; emoji and spaces between references remain intact. `interactive` and CSS `ellipsis` remain React Props, not matching Facts. Queue uses full original text with CSS ellipsis; native attachments remain in their existing cards and image Slots, outside text recognition.

## Verification requirements

Pure logic tests assert both the final nodes and each matcher's ordered calls with their `from` offsets. They use deterministic input and spies rather than clocks or performance thresholds.

- Initialization calls every matcher, including Facts-free and no-match rules; empty input has explicit terminal-query behavior.
- Earlier starts beat stronger order values; same-start ties use order and stable ID, and each matcher preserves its own longest-match choice.
- A future candidate and a no-match answer are not requested again during forward traversal; only the winner and overlapping heads advance.
- Unread Facts changes and new outer Facts objects with unchanged field values cause no matcher calls.
- One or several changed fields rerun exactly their readers; missing fields, losing candidates, no-match results, failures, and conditional read-set replacement remain covered.
- Equivalent refreshes preserve node/array identity and do not invoke unrelated matchers; payload-only changes preserve unaffected nodes.
- Insertions in plain text, losing new candidates, same-start winner changes, extending/shrinking matches, and removal of an early winner assert the exact affected query offsets and counts.
- Removing or shrinking a winner exposes cached losers and unsearched gaps; an old tail no-match result cannot answer a query before its recorded origin.
- Batched Facts updates equal a fresh evaluation under the same snapshot and do not give the first refreshed matcher precedence.
- Text and rule-definition changes, registration/disposal, range validation, synchronous failure containment, Context lifetime, and independent evaluator state have deterministic tests.
- Real Session/file/skill/command combinations preserve full quoted references, original word boundaries, and same-start precedence; whitespace candidates use exactly the same scheduling and cache rules.

## Alternatives considered

**Ordered whole-document business transforms.** A business can consume later text before an earlier reference from another business is considered, so fixed type order does not express leftmost recognition.

## Consequences

Field-level invalidation can require a matcher to traverse the document again; it does not promise per-element Facts invalidation. Query history consumes memory proportional to the distinct recorded search positions for the current text and definitions. Reconciliation and JSON identity alignment can still traverse output without invoking matchers. The performance evidence is the exact scheduling count and query offsets, while semantic evidence compares refreshed output with a fresh evaluator. This mechanism requires no browser end-to-end or elapsed-time benchmark tests.
