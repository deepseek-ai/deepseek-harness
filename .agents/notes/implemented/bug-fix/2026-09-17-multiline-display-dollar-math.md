# Agent Note: Multi-line display-dollar math

Status: implemented

English | [中文](2026-09-17-multiline-display-dollar-math.zh.md)

## Problem

Authors and models write `$$` display math in three shapes. The settled grammar rendered two of them: `$$math$$` on one line, and an opening `$$` alone on its line closed by `$$` alone on its line. The third shape — math on the opening line, a closing `$$` at the end of the last math line — did not:

```markdown
$$f(x)=x
\text{continued}$$
```

`micromark-extension-math` treats text after an opening `$$` as fence meta and accepts a closing fence only on a line whose content is exactly `$$` (after optional whitespace). The [markdown compatibility layer](../../archived/feature/2026-07-23-web-assistant-markdown.md) claimed only the same-line shape, and the settled renderer passes `node.value` to KaTeX while ignoring `node.meta`. The block therefore never closed: it consumed the document text that followed, `value` retained the literal `$$`, KaTeX raised `Can't use function '$' in math mode`, and [katex.tsx](../../../../packages/client/ui-primitives/src/markdown/katex.tsx)'s error arm painted the TeX source plus the swallowed prose in red.

In the session that surfaced this, one chat reply lost lines 22–55 of 55 to a single error span, and six note files lost every line after such a block (up to 500 lines) to one. A second defect shared the mechanism: when a later lone `$$` did close the flow, the opening line had already been assigned to `meta`, so the renderer silently dropped the first line of the formula.

## Decision

[mathCompatibility.ts](../../../../packages/client/ui-primitives/src/markdown/mathCompatibility.ts) gains multi-line display-dollar blocks. Its dollar construct keeps the opening line's text in `mathFlowValue` instead of fence meta and closes at a trailing `$$` on any later content line, so `$$a+b` continued by `c+d$$` becomes one math node.

A `$$` sequence that fails to close ends the candidate: immediately on a later line, and at that line's ending on the opening line (`$$x$$ trailing` fails there). Within the opening line the scan continues, so a later `$$` there still closes (`$$\verb*a$$a$$`). Scanning past either point would consume a later block's closing fence. A solitary `$` is content rather than a failed fence, so a formula that uses one — `$$P = \begin{cases} 1 & \text{if $x>0$} \end{cases}$$` — keeps the block open and closes normally wherever this flow owns the block. A trailing backslash escapes the line ending, not the next line's first character, so the escape run ends at the line ending instead of reaching into the next candidate. An unescaped `%` starts a TeX comment that runs to the line ending, so a `$$` at the end of a later line closes nothing when the comment holds text before it. A `%` whose text before the fence is empty or whitespace (`95%$$`, `95 %$$`) holds no comment text, and a block that opens and closes on one line keeps closing at that line's `$$`, as it did before this flow spanned lines. That state and its gate on the closing check belong to the dollar flow. The characters right after `\verb` or `\verb*` are that command's delimiter rather than a fence, so the delimiter and, when the region is empty, the `$` closing it are content; that tail is cleared at a line ending and after an escaped backslash (`\\verb` is a line break followed by letters), and a comment holds no commands. Otherwise verbatim regions are not parsed, which keeps `\verb`-bearing formulas on the same value path as every other input.

Its paragraph-interruption check declines instead of consuming the line ending, for the dollar construct only. Consuming it there keeps the paragraph open across the line boundary, so the document layer keeps the container and counts the next line lazy for every construct tried afterwards; that made upstream's `mathFlow`, the construct tried after this one, end empty inside a list item. Declining also leaves the interruption decision to that upstream flow, whose own check short-circuits without consuming and claims only the fences it accepts, so a candidate neither construct accepts (`**before` followed by `$$a\$b`) leaves its paragraph intact. The backslash construct has no competing upstream construct and keeps consuming there.

[parse.ts](../../../../packages/client/ui-primitives/src/markdown/parse.ts) registers `mathCompatibility()` after `math()`: micromark dispatches the extension registered last first, so the dollar flow above takes precedence over upstream's `mathFlow` while `math()` still owns inline `$…$`.

## Alternatives considered

**Keep the compatibility layer at same-line `$$…$$`.** The multi-line shape is what GitHub, KaTeX's auto-render, VS Code, and Typora accept, and the form models emit for multi-case formulas; leaving it unparsed means a red error span in place of the formula plus the rest of the document.

**Repair the parsed tree afterwards.** The flow consumes the swallowed text into `mathFlowValue`, where it is indistinguishable from math source; `meta` and `value` cannot be reassembled into the intended block, and the following blocks were never parsed at all.

**Rewrite `$$` fences in the source text before parsing.** The compatibility layer is a grammar extension by design; a text pass would need to locate code spans, fences, and escapes itself, and would change author text rather than parse it.

**Continue the dollar flow after a failed close.** That is what a plain `multiline` flag produces: `$$x$$ trailing\n\n$$y$$` then scans to the second block's `$$` and renders one math node holding both lines' text, where upstream inline math renders `x`, the prose, and `y` separately. Existing behavior for `$$x$$ trailing` already pinned the fallback, so the flow declines the candidate instead. Declining on any `$` rather than a full `$$` sequence also broke formulas that use a solitary `$` inside `\text{}`.

**End the attempt as soon as one line resists parsing.** Declining every failed same-line close swallows nothing but turns `$$a$b` lines into a quadratic scan and drops the solitary-`$` formulas above. The condition is the full `$$` sequence, not the character.

**Claim the paragraph interruption in the check.** Returning success there, as upstream's flow does for the fences it accepts, prevents the lazy bookkeeping that broke the list case, but it also ends the paragraph for candidates that later fail (`**before\n$$a\$b\nafter**` split in two and exposed its `**`). Declining instead lets upstream's own check decide.

**Apply the interruption guard to the backslash construct too.** The guard exists to protect the construct tried after this one; `\[`/`\(` have no second construct, and an unconditional guard dropped their multi-line blocks (`Prose line` followed by `\[`).

## Consequences

The three shapes now produce the same math node, so formulas stop truncating at the opening line and stop swallowing the prose after them. `$$` fence meta is no longer honored: `$$asciimath$$` parses as a formula whose value is `asciimath`, which upstream's flow treats as fence meta and drops. That spelling has no user in this repository, and the renderer never read `meta` anyway.

Six inputs still reach upstream's flow or stay in the surrounding paragraph, because the compatibility flow declines them. Trailing text after a closing `$$` (`$$x$$ trailing`, or a CJK quote mark closing a line of prose) resolves through upstream inline math, as the existing `markdown.client.spec.tsx` case pins — including when a later `$$` block follows. A `$$` sequence the line does not end after declines the block: immediately on a later line, and at that line's ending on the opening line. A `$$` block left open runs to the next lone `$$` or to EOF exactly as it did before this change, because the upstream flow closes at EOF.

The fourth is a multi-line block whose opening line carries a solitary `$` and that must interrupt a paragraph, with no blank line before it. Both flows decline the interruption there — this one by design, upstream because its fence meta stops at the `$` — so the block stays inside the paragraph and renders as inline math or not at all. Separating the block from the paragraph with a blank line makes this flow own it and render the display block.

The fifth follows from the comment gate: a block whose only closing fence sits behind a comment that holds text keeps scanning instead of closing there, so when nothing else closes it the block reaches the upstream flow as the shapes above do. A fence behind a whitespace-only comment closes the block there, which leaves a following lone `$$` as its own empty block where the flow it replaced kept one node.

The sixth is a multi-line block inside a container whose continuation line falls back to the container's indentation. `- Define:` followed by `$$f(x)=x` at the item's indentation and then a de-indented continuation line gives upstream's flow a fence meta and no value, so the reader sees an empty display block and the continuation as prose — the opening line is gone. Keeping the continuation at the same indentation, or moving the block out of the list, renders it normally. Both flow behaviors match the grammar this replaced; only the multi-line blocks this flow owns are new.

One further limitation is not a fallback: the flow reads the six characters before a fence and does not parse verbatim regions, so a fence inside an unterminated region (`\verb|$$`) closes the block there, and a region whose text ends in `\verb` (`\verb**\verb*$$`) has its fence read as that text's delimiter. The six characters before either fence are locally identical, so no rule that reads only that tail separates them.

Repeated unclosed candidates keep linear parser work: an open candidate declines at the next line that starts with a full `$$` it cannot close, rather than scanning each candidate to EOF, which would make 9.6 KB of `$$a$b` lines take ~4 s instead of ~16 ms. KaTeX-level failures in a formula's own source, such as `\arccot`, remain errors by design.

## Testing

`packages/client/ui-primitives/tests/markdown.client.spec.tsx` adds the multi-line case — opening-line math closed on a content line, closed by a lone fence, after a paragraph, inside a list item, and at column zero after a list item — and that case fails without the change. The same file also pins a multi-line formula that uses a solitary `$`, which like the case above renders only with this change. Further cases pin one condition each: a trailing-text candidate ahead of a later block (the flow must decline a full `$$` the line does not end after), a solitary `$` inside a single-line display formula (the flow must not decline on a single `$`), an escaped-dollar candidate that leaves its paragraph intact (the interruption check must not claim the paragraph), an unclosed `\[` candidate that leaves its paragraph intact (the guard must not apply to the backslash construct), a candidate ending in an odd backslash (the escape run must end at the line ending), a closing fence inside a TeX comment, a `%` the fence follows immediately or after whitespace, a second `%` inside an open comment, a `%` inside `\verb|…|`, the delimiter right after `\verb` and `\verb*` together with its empty region, an escaped backslash before `verb`, a verb tail that crosses no line ending, a comment ending in `verb`, a later-line trailing fence whose following prose upstream takes, a failed fence inside a comment, and bounded-work cases for repeated candidates with that backslash, without it, and ending in a verb tail.

The DOM compatibility corpus adds `math-multiline-display` with its `.settled.txt` and `.streaming.txt` fixtures, which also pin that a column-zero `$$` after a list item stays outside the list item. `apps/web/tests/math-rendering.e2e.ts` renders the multi-line shape in the browser lane.
