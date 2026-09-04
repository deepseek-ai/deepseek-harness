# AGENTS.md — Recorded-session snapshots

This tree contains only tests whose committed session JSONL is replay input and expected persisted output. Keep non-session ARIA, geometry, generator, CLI, and unit expected output with its owning app, script, or package; use `test:expected`, `test:web`, or `test` for its owning tier.

Every process under test starts through the `dsh` CLI with a shipped profile and optional scenario patches. Test clients may drive a public protocol or browser interface; do not add another application entrypoint, hidden CLI mode, or executable scenario driver.

Each scenario owns or explicitly references one primary Session role plus contiguous child roles. Canonical parent filenames are `session[.vN].jsonl`; children are `session.<ordinal>[.vN].jsonl`; v0 omits `.v0`, positive versions use lowercase `.vN`, and every filename agrees with its header. A directory may retain several generations of one role, but replay, record, and refresh select the numerically highest. Record and refresh write version-named outputs without renaming or deleting a committed generation; reviewed source-tree curation is separate. The owner alone records or refreshes the selected role. For an ordinary one-shot case, derive the user task and replay script from that selected JSONL; do not duplicate them in an `input.json`. Shared references are read-only, acyclic, point to the owner's selected parent generation, and are used only when another interface intentionally renders the same recorded behavior.

An owner that must keep a historical generation declares its exact `sessionFormat.version` and closed migration `coverage` names in `snapshot.yml`; record and refresh never rewrite that Session fixture. Owners without this declaration track current-writer output.

Committed sessions are normalization fixed points. Replace volatile identities with typed relationship-preserving tokens, replace request system prompts and tool schemas with tokens, and keep exactly one readable sidecar owner per header class. Never redact arbitrary user or tool text merely because it resembles an identifier.

An adapter-local symlink may expose a cross-profile prompt or schema sidecar only when `snapshot.yml` names that source; the corpus gate resolves the link and checks the declared target. The required snapshot lane runs these aliases on macOS and Linux.

Workspace seeds stay scenario-local. A scenario that mutates the workspace sets `workspace.final: true` and commits the complete result under `workspace.expected/`; use only the ignored `.empty` marker for an empty result. Record and refresh do not rewrite this independent oracle. Model prose and tool-result text do not prove the external effect.

`pnpm run test:snapshot` replays without writes. Recording and refresh use the explicit snapshot scripts, and every resulting JSONL, prompt, schema, protocol, UI, and workspace diff is reviewed before commit.
