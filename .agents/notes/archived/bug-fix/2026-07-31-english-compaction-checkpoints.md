# Agent Note: Compaction checkpoints use an English engineering register

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-31-english-compaction-checkpoints.zh.md)

## Problem

A compaction checkpoint becomes part of the next model request's durable prefix. When a multilingual conversation leads the compactor to preserve its narrative material in the conversation language, the checkpoint can introduce a large amount of a language that is absent from the code, tool output, and existing reasoning prefix. That language then persists across later compaction cycles and can influence the conversation model's reasoning register.

## Decision

`COMPACTION_INSTRUCTION` requires an English-language internal engineering checkpoint. It asks the model to translate narrative source material as needed while preserving exact literals, including paths, commands, errors, identifiers, signatures, and quoted wording when exactness matters. The checkpoint's headings and terse engineering bullets remain the existing structured format.

The requirement is integrated into the first sentence of the trailing compaction instruction. The replayed system prompt, tools, and conversation history remain byte-identical to the routed request, so the change retains the prefix-cache reuse owned by the [compaction summary prefix-cache note](2026-07-21-compaction-summary-prefix-cache-reuse.md).

## Alternatives considered

- **Leave checkpoint language to the replayed conversation** — rejected: the checkpoint is a durable prompt prefix, so preserving a transient conversational register can amplify it across later compactions.
- **Constrain the conversation model's language** — rejected: the policy is for an internal checkpoint, not the user's visible conversation, and a conversation-wide rule would unnecessarily change normal interaction.
- **Require ASCII-only output** — rejected: ASCII is a character-set constraint rather than an engineering-register constraint and would unnecessarily distort legitimate literals and technical material.
- **Append a separate final English-only sentence** — rejected: stating the requirement in the instruction's opening output contract is shorter and ties it directly to the checkpoint being requested.

## Consequences

- New checkpoints normalize narrative context into English while retaining the exact strings that future tool use and code work depend on.
- Existing checkpoint structure, compaction routing, and cache alignment are unchanged; only the final user instruction is different.
- The direct summarization call remains outside transcript snapshots because it emits no Agent-owned Assistant settlement. The real-loop regression instead asserts the exact final instruction received by the summarization request.
