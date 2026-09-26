# Agent Note: Markdown file preview links

Status: implemented

English | [中文](2026-09-15-markdown-file-preview-links.zh.md)

## Problem

Assistant explanations link to existing source files that the turn does not modify or deliver. Restricting clickable references to produced-file mentions prevents readers from opening those sources beside the answer.

## Decision

Settled Assistant Markdown passes explicit local link destinations to the Chat file opener through `MarkdownDelegateProvider`. The provider owns both file and HTTP(S) navigation callbacks; nested link components read its current callbacks without adding navigation props to intermediate renderers. The renderer recognizes absolute and workspace-relative paths, decodes percent escapes once, and separates `#L24` or `#L24-L30` into a first-line navigation request. A file control preserves the authored label and shows a file-category icon. It never navigates the browser to the authored path.

The existing [Sidebar navigation](../architecture/2026-09-05-sidebar-tab-types-and-navigation.md) owns Session addressing, tab reuse, and preview selection. The Host file service retains access checks and missing-file errors. Inline-code produced-file matching remains independent. External URLs retain their protocol allowlist; queries, fragment-only destinations, unsupported fragments, malformed escapes, and invalid line ranges remain inert.

The Web file-reference prompt asks for a link on every existing-file mention outside commands, configuration expressions, and code blocks, including repeats and tables. Names default to a basename or clear alias with minimal disambiguating parents. Precise labels use `filename:24` or `filename:24–30`, while destinations keep the parser's `#L24` or `#L24-L30` syntax. The renderer preserves model-authored text; it does not rewrite labels to enforce the prompt.

## Alternatives considered

**Relative browser anchors.** They navigate the application URL instead of requesting Session file content.

**Require a produced-file entry.** This excludes ordinary read-only explanations.

**Add a preview service.** Chat already supplies the required opener and line parameter.

**Thread navigation callbacks through renderer props.** Every new navigation capability would enlarge unrelated intermediate interfaces. Reading the scoped delegate at link components also lets cached Markdown observe handler changes.

**Filename-first or display-only prompt variants.** The three-variant development comparison favored A for occurrence-level link coverage and the user preferred its output. B produced more answers with no missing links, so these observations do not establish a universal winner. Visible `#L` suffixes were rejected in favor of the familiar colon notation; retaining anchor syntax in destinations preserves existing navigation.

## Consequences

Source references need no new Session event. The static Web guidance is logged through the existing system-message mechanism. Links become active when the message settles. A range selects its first line; the preview does not highlight a multi-line selection. Unit tests cover destination parsing, shared file and HTTP(S) routing, nested scopes, and callback replacement or removal; the keyless `markdown-file-links` Web snapshot covers file content, colon labels, line navigation, and tab reuse through the shipped composition. The package tests check the guidance in every Web prompt sidecar.
