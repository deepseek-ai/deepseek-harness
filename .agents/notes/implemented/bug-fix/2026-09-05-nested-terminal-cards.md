# Agent Note: Nested terminal cards

Status: implemented

English | [中文](2026-09-05-nested-terminal-cards.zh.md)

## Problem

A shell command dispatched through `run_code` carries the arguments and rendered output needed for a terminal card, but rejecting every block with `parentCallId` hides that presentation solely because the call is nested. The rejection also affects running prompts and selected-child Details.

## Decision

`terminalCardModel` applies the same eligibility checks to root and Code Dispatch calls, without rejecting `parentCallId`. Supported running and settled `bash`, `pwsh`, and `terminal_send` calls use the existing terminal card. Background calls, tool errors, malformed inputs, missing call heads, and unsupported result content retain generic fallback. Persistent shells remain eligible while running and generic when settled; a nonzero process exit remains terminal result data rather than a tool error.

This partially supersedes only the terminal child-card prohibition in [Client-derived tool presentation](../architecture/2026-08-23-client-derived-tool-presentation.md). That note remains active for Client presentation ownership and the diff/read/search/web child restrictions. No Host presenter, event, schema, metadata, call-tree, or model-context change is required. The metadata and execution-local value decisions in [canonical tool output](../architecture/2026-07-20-canonical-tool-output-contract.md) and [PTC typed returns](../feature/2026-07-20-ptc-typed-tool-returns.md) remain intact; metadata omission does not prohibit Client-derived terminal cards.

Shell output ending in a recognized spill-policy notice uses generic output: expandable in `BashRow`, raw fallback in Details. The notice can follow or replace the exit marker, so its absence at the end does not justify a successful terminal status. The browser-safe `@deepseek-ai/dsh-spill-policy/notice` entry owns the text convention: the producer calls `formatSpillNotice(omitted, ref)` and the Client calls `hasSpillNotice(text)`. Both share delimiters, and omission validation reuses `describeOmitted` rather than duplicating its prose. The formatter preserves the persisted spelling byte-for-byte; existing Session result bytes stay untouched, with no Session format change or migration.

## Alternatives considered

**Keep the blanket nested-call rejection.** Rejected because nesting does not remove the raw facts the terminal model already consumes. It hides usable shell output while the same call renders as a terminal at the root.

**Enable every nested structured card.** Rejected because other card models have independent metadata requirements and child restrictions. This fix changes only terminal eligibility.

**Parse exit markers around spill suffixes.** Rejected because truncation can remove the real status; conservative generic output avoids guessing success from an incomplete result.

**Maintain a separate UI notice regex.** Rejected because it duplicates the producer's text convention and can drift from persisted output. The shared browser-safe owner keeps formatting and recognition together without loading the Host plugin in the browser.

## Consequences

Rows and Details share terminal derivation for nested calls without a second renderer or presentation hint. Generic fallback and settled-persistent behavior remain separate from terminal-card eligibility. The parent-child relationship still controls tree placement, not terminal rendering. Text recognition cannot authenticate output: a tool can print the same notice. A match selects conservative generic presentation, not proof of spill provenance or process status.

## Verification

The [terminal card specs](../../../../packages/client/ui-tool/tests/terminal-card.client.spec.tsx) cover root/child eligibility, running and settled Details, and fallback cases. The [assembled Code Dispatch specs](../../../../packages/client/ui-tool/tests/chat-code-subcalls.client.spec.tsx) cover nested terminal rendering through the conversation tree. The [notice specs](../../../../packages/spill/spill-policy/tests/notice.spec.ts) pin the historical spelling with a literal fixture independent of the formatter. The [spill-policy-to-UI specs](../../../../packages/client/ui-tool/tests/spill-policy-terminal.client.spec.ts) exercise actual root and PTC spill production, unchanged full text and programmatic values, byte caps, notice-only output, and terminal fallback. Browser replay owns the visible nested-card change; nonterminal child behavior remains outside this fix.
