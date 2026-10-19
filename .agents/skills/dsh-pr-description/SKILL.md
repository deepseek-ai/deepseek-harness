---
name: dsh-pr-description
description: Use when creating a deepseek-harness pull request, or when updating its description after later changes or a handled review round. Defines each description section, Issue references, test design, change-specific disclosures, and the Human and Agent Roles section with its levels, stages, grading rules, and update timing.
user-invocable: false
---

# Writing PR descriptions

This skill defines what a deepseek-harness PR description contains, how to write it, and when to update it. The [PR template](../../../.github/pull_request_template.md) supplies only the section headings and placeholders; this skill owns the requirements for each section. Every PR description follows this skill, including PRs created with `gh pr create --body-file`, which skips the template.

## Scope

- Write the complete description when you create the PR.
- After the PR exists, update the affected sections when the description no longer matches the PR, at times you judge suitable.
- Each PR in a stack has its own description, which covers only that layer's changes against its base branch.

## Description structure

The description uses four second-level headings, in this order: `## Motivation`, `## Changes`, `## Testing`, and `## Human and Agent Roles`.

Write all headings and labels, such as **Interface changes**, **Behavior changes**, **Test design**, and **Test entries**, in English. Write the rest of the description in Chinese unless a human asked for another language for this PR.

### Motivation

- State the problem in one sentence.
- Reference at least one same-repository Issue: use `Fixes #N`, `Closes #N`, or `Resolves #N` when the PR resolves it, and `Refs #N` when it only gives context. PR numbers do not count as Issue references, and neither do references inside HTML comments, code fences, or inline code. [Issue management](../../../.github/issue-management/README.md) owns the exact rules and the Priority matching.

### Changes

- Interface changes: summarize changes to commands (including repository scripts), flags, configuration keys, environment variables, public exports, plugin registration values, protocols, or persisted formats; write None when there are none.
- Behavior changes: summarize results that users, models, developers, or the system can observe, including defaults, performance, timing, and output; write None when there are none. Changes to documentation and agent instructions, such as READMEs, AGENTS.md, and skills, are behavior changes for the readers they guide.
- State only behavior that the diff guarantees and the tests cover.

### Testing

Testing starts with the test design, followed by the test entries.

**Test design**: summarize how the tests cover each item in Changes and why that coverage is complete. Choose the form by change type:

| Change type | What the test design shows |
|---|---|
| Behavior change | A behavior matrix of scenario × behavior before × behavior after × covering test, showing which scenarios failed or differed before the change |
| Performance change | Before and after values per stage or scenario, with the measurement conditions: machine, run count, and how the value is taken |
| Refactoring or migration without behavior change | How the unchanged behavior is shown: byte-for-byte comparison, unchanged snapshots, or old-versus-new comparison tests |
| Documentation only | How the content is checked: links, bilingual pairing, example compilation, or similar |

When the PR mixes change types, give one form for each type present. Items that Changes lists as None need no test design.

**Test entries**:

- Add one entry per test method; state the command or steps visibly, and the behavior it covers.
- List only tests that have run, with their results; add later runs when the description is updated. State whether the evidence comes from a local run or from CI.
- Put reviewable evidence, such as test output, screenshots, recordings, or logs, in that entry's `<details><summary>Proof</summary>` block; when the full output is long, the block may hold the command, the counts, and a result summary.

### Change-specific disclosures

Write each disclosure in the section it concerns, usually Changes, after a bold English label that names it, such as **Existing test behavior**; do not add headings.

| Change | What the description states | Rule owner |
|---|---|---|
| Changing the behavior an existing test describes | Why the behavior changed | The Tests describe behavior rule in [root AGENTS.md](../../../AGENTS.md) |
| Raising a ceiling in `scripts/doc-budgets.manifest.json` | Each raised ceiling with its old and new value, and why the words are necessary | [Wordcount budgets](../../../docs/AGENTS.md#wordcount-budgets) |
| Changing product-user-visible GUI behavior | An embedded demonstration GIF, with the disclosures that record-browser-gif requires beside the embed; for each GUI change without a GIF, a statement that none is embedded and why | [record-browser-gif](../record-browser-gif/SKILL.md#every-gui-pull-request-includes-a-gif) |
| Using a translation term the terminology list lacks | The source of the rendering, or a proposed rendering under pending terms | [Translation rules](../../../docs/i18n/translation-rules.md) |

## Human and Agent Roles

This section records who made the decisions in each stage of the PR, and how autonomously the Agent worked.

### Levels

Levels are ordered from least to most AI involvement; each level pairs an English name with a Chinese name. Autonomy is the Agent's autonomy in that stage, a multiple of 5% within the chosen level's range.

| Level | Meaning | Agent autonomy |
|---|---|---|
| hint 人工独立 | A human does the work; AI takes no part or only offers passive suggestions that the human accepts or rejects | 0–10% |
| assist 人工主导 | A human supplies the main content or every key decision; AI completes part of the work | 15–25% |
| pair 人工引导 | A human gives the key direction or constraints and revises the AI's output several times; the human understands the internals | 30–50% |
| copilot 人工把关 | AI completes the whole task; a human reviews, selects, or rejects, and decides or clarifies key points without supplying substantive content | 55–85% |
| auto 模型自主 | AI completes the task autonomously; a human only sets the goal or accepts the output | 90–100% |
| n/a 暂不适用 | The stage does not exist or has not happened yet | Omitted |

### Stages and criteria

Stages appear in a fixed order; each stage pairs an English name with a Chinese name. The criteria below cover assist through auto; judge hint by its meaning in the level table.

**breakdown 问题拆解**: after the problem appears, whether a human takes part in breaking it down, or the Agent acts on it directly. Confirming that a problem should be fixed belongs to this stage, not to design.

- auto 模型自主: the Agent acts on the problem directly.
- copilot 人工把关: the Agent identifies the subproblems, root cause, and scope; a human only confirms them or removes items from the Agent's list.
- pair 人工引导: a human contributes one or two key facts, such as a suspected direction, a key subproblem, a trigger condition, or a scope limit, or requires tracing the root cause; the Agent identifies the rest.
- assist 人工主导: a human supplies the list of problems or subproblems that make up the PR's scope, or the root-cause judgment, and sets the scope; the Agent traces the root causes or works from that list.

**design 方案设计**: who supplies the logical design, and how many trade-offs and detailed changes the human makes. Grade by who supplied the design structure that was adopted, not by who proposed candidates first: when the Agent proposed candidates and the human then supplied the adopted structure, the stage is assist. Design structure means the module split, data flow, key interfaces, or state transitions; for documentation, the directory, page split, and responsibility layering. Constraints stated as observable outcomes are constraints, not structure. A structure that the human reached through successive corrections counts as supplied by the human.

- auto 模型自主: a human adopts the Agent's design as proposed, or only confirms an option the Agent recommends.
- copilot 人工把关: a human chooses among the Agent's designs, or rejects parts of one.
- pair 人工引导: the Agent proposes the design structure; a human gives key constraints, names, or several revisions.
- assist 人工主导: a human supplies the design structure (module split, data flow, or key interfaces); the Agent fills in the mechanism or writes it up.

**testing 验收测试**: who sets the acceptance goals, test cases, and test matrix, and who checks the results. For documentation-only changes, the acceptance goals are content requirements. Instructions that only order the work, such as writing tests before the fix, do not count.

- auto 模型自主: the Agent sets the goals and cases; a human at most approves publishing or confirms a scope the Agent recommends.
- copilot 人工把关: a human reviews or comments on the cases, the test matrix, or the results the Agent reports.
- pair 人工引导: a human sets quantified targets or required scenarios, such as a trigger condition or a before-and-after contrast that must be covered, or, for documentation-only changes, content requirements; the Agent designs the concrete cases.
- assist 人工主导: a human defines the test matrix, its dimensions or rows, and runs or tries the result to check it; the Agent may fill in the values and cases.

**implementation 技术实现**: human intervention in the changed content, including production code, documentation (READMEs, JSDoc, Agent Notes, comments), CI, and release scripts.

- auto 模型自主: the Agent writes every change, and the records show no human diff review.
- copilot 人工把关: a human reviews the diff, including staging it piece by piece, and accepts it or makes a few comments that do not require redoing work.
- pair 人工引导: a human requires reverting or redoing any part of the work, or specifies a refactoring or an implementation approach.
- assist 人工主导: a human writes the key parts in the diff; the Agent completes the rest. Dictating content for the Agent to write is not writing it.

**review 评审处理**: who decides whether each handled review comment is fixed or declined. Comments from bots and from people both count; grade by who decided, not by who posted the reply. When no review comment has been handled, the line stays n/a, even if comments exist or arrived after merge.

- auto 模型自主: the Agent decides on and replies to every comment.
- copilot 人工把关: a human gives only a blanket authorization or category-level instructions, or responds to only a few items on a handling list the Agent prepared and leaves the rest to the Agent.
- pair 人工引导: a human responds to every item other than wording, in the threads or on the Agent's list, deciding to fix, decline, or defer, even with a short acceptance; merged duplicate comments count as one item, and wording comments may be handled by category; the Agent carries out the decisions and replies.
- assist 人工主导: a human posts replies to reviewers directly, or leads the discussion of disputed items; deciding while the Agent posts the replies is pair.

### Grading rules

- Grade from session records and task records. Messages a human sends in a subagent session count; the instructions an Agent writes to a subagent are not human messages.
- Count only work that ends up in this PR, including work from earlier sessions that ends up in this PR. A human's request to revert or redo work counts even when the reverted work does not remain in the PR.
- In breakdown, design, testing, and implementation, the human is the author working with the Agent; reviewers' approvals and comments count only in review.
- Process and ordering instructions, such as branching, working order, staging, and when to commit, push, or open the PR, do not count as human involvement in any stage.
- When the records suffice, grade at the level with the most human involvement whose criterion the records meet, and express the human and Agent shares through the autonomy value. Only when the records do not suffice, take the level with less human involvement that the records support.
- When a stage covers several changes, grade by the main change and state how the other changes differ in the description. The main change is the one with the largest share of the diff and review effort; when no single change dominates, grade by the change with the most human involvement. When later work changes which change is main, regrade the stage.
- Within the chosen level's range, choose a lower autonomy value the closer the human involvement comes to the criterion of the level with more human involvement, and a higher value the closer it comes to the level with less.

### Line format

The section starts with one level line, followed by one line per stage in the fixed order:

```markdown
## Human and Agent Roles

Levels and Agent autonomy: <ins>**hint 人工独立**</ins> 0–10%, <ins>**assist 人工主导**</ins> 15–25%, <ins>**pair 人工引导**</ins> 30–50%, <ins>**copilot 人工把关**</ins> 55–85%, <ins>**auto 模型自主**</ins> 90–100%; <ins>**n/a 暂不适用**</ins> marks a stage that does not exist or has not happened yet.

- <ins>**<level English name> <level Chinese name>**</ins> <autonomy> · <stage English name> <stage Chinese name> — <description>
```

- Write the level in bold and underlined; omit the autonomy value for n/a 暂不适用.
- Write the description in the PR description's language, in one or two sentences of at most 80 Chinese characters or 40 English words. State who made which decisions: name one or two representative decisions, and give only a count for the rest.
- State the description as settled fact, without hedges such as "not seen in the session" or "pending author confirmation".
- Refer to people as the author or a reviewer, never by username. Leave out judgments, session times, session ids, direct quotes, and the running or handling of checks and CI (local skips, hooks, reruns, unrelated failures).

### Update timing

- When you create the PR, the review line reads `- <ins>**n/a 暂不适用**</ins> · review 评审处理 — ` followed by a statement, in the description's language, that no review comments have been handled yet.
- When the description is updated after the PR exists, rewrite the affected lines so that they cover all work so far, including earlier stages whose decisions or human share the later work changed; do not append a history of changes.
- The review line records only handled review comments; it omits approvals, merge timing, and unhandled comments.
- A review round ends when its fixes are pushed and its comments answered. Comments that arrive after merge do not trigger an update.

### Example

Filled in from the session and review records of #6013:

```markdown
- <ins>**pair 人工引导**</ins> 40% · breakdown 问题拆解 — The author identified two process-specific values that do not belong in the system prompt and pointed to the custom model route; the Agent traced the root cause.
- <ins>**assist 人工主导**</ins> 20% · design 方案设计 — The author supplied the design structure: runtime context, frozen legacy sections for old sessions, and a separate package; the Agent filled in the projection matching.
- <ins>**pair 人工引导**</ins> 40% · testing 验收测试 — The author required two scenarios: restoring an old session after upgrade, and changing ports after upgrade; the Agent wrote the cases and snapshots.
- <ins>**pair 人工引导**</ins> 35% · implementation 技术实现 — The Agent wrote the code and the Agent Note; the author required one revert and specified 3 approaches, such as getOrigin() instead of an origin property.
- <ins>**pair 人工引导**</ins> 40% · review 评审处理 — The author decided each bot comment, such as no upgrade guide and keeping a devDependency; the Agent fixed and replied.
```

## Creating and updating the description

1. Write the description to a file that git ignores, such as `.artifacts/pr/body.md`. Create the PR with `gh pr create --body-file <file>`, or update it with `gh pr edit <number> --body-file <file>`; when the description embeds a GIF, follow [record-browser-gif](../record-browser-gif/SKILL.md) and use `--attach`.
2. Before an update, save the current description with `gh pr view <number> --json body --jq .body`, and change only the sections that need it: keep content and media the author wrote, and remove statements that no longer match the code.
3. After writing, read the description back and confirm that all four sections are present and that Human and Agent Roles matches the current code and review state.
