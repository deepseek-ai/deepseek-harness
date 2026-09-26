---
name: agent-experience
description: Use when writing or changing a model-facing tool definition (name, description, parameter schema, or its system-prompt section), and when designing skills, context loading, or multi-step workflows, to make information discoverable and use context efficiently.
metadata:
  date: "2026-09-11"
---

- **Start with minimal context:** expose purpose, available actions, and constraints first; load detailed instructions when needed.
- **Make discovery explicit:** every deferred resource needs a clear description and a reliable way to retrieve it.
- **Keep critical constraints visible:** permissions, destructive effects, and required validation should appear before the relevant action.
- **Prefer bounded outputs:** return concise results with identifiers or paths for retrieving details; avoid dumping entire logs or documents.
- **Use locality:** include a bounded amount of likely needed adjacent context with an operation’s result. For example, deliver a thread reply with a few preceding messages. Mark omissions and truncation explicitly, and provide a way to retrieve more.
- **Evaluate total work:** saving context is useful only if it does not cause more searches, repeated reads, or mistakes.

## Tool definitions

- **Delete obvious constraints.** Omit rules the model learns from the call result, such as a missing file failing to read or a failed send not being delivered.
- **Describe behavior, not implementation.** State what the tool does and returns; omit internal mechanisms, output markers the model sees in results, and enforcement details.
- **Put parameter rules on the parameter.** Defaults, ranges, pairing, and when-to-set rules belong in that parameter's description or schema; a description that varies with configuration usually means the varying part belongs to a parameter.
- **Say each fact once.** Do not repeat the tool definition in its system-prompt section, a parameter description in the tool description, or one tool's rules in another tool.
- **Measure the change.** Compare first-turn prompt tokens before and after a tool-definition change.
