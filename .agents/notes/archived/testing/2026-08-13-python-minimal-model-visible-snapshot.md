# Agent Note: Python minimal-composition model-visible snapshot

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-13-python-minimal-model-visible-snapshot.zh.md)

## Problem

The Python lane needs an exact record of what the standalone minimal profile shows the model. Functional tool assertions prove execution but do not reveal an added system section, tool description, or user-role context message, while the advanced executable snapshot replaces each request header's assembled system prompt with a token and each tool schema with its name.

## Decision

The `sdk-minimal` scenario in [the packaged-runtime smoke](../../../../scripts/smoke-python-runtime.py) boots the shipped profile and records `scripts/snapshots/python-sdk-single-exe/minimal/model-visible.json`: for every model request of the turn, the advertised tool schemas verbatim and the message list. System and user messages keep their full text with the scenario's temporary directory tokenized; assistant and tool messages keep only call identity, because their PTY and filesystem text differs across replay platforms. The profile omits dynamic runtime context, so every message it emits is compared.

The snapshot, rather than inline mock-model assertions, owns the minimal scenario's tools and system prompts and reports their complete diff. Snapshot comparison takes its directory and file set as arguments, so the `minimal` and `advanced` expected outputs use one implementation, and `--update-snapshots` accepts `sdk-minimal`.

## Alternatives considered

**Snapshot the minimal session log, like the advanced scenario.** The minimal turn drives a real PTY and editor, so persisted tool results carry platform-dependent text. The expected output would go red for reasons unrelated to model-visible assembly, and normalizing that text away leaves the log carrying little the model-visible file does not.

**Extend the mock model's inline assertions.** Every new model-visible contribution would need another hand-written expectation, and a failure names one mismatch rather than the whole surface. Tool descriptions would also be duplicated from the composition into the script.

**Rely on the TypeScript SDK snapshot.** Its `persistent-tools` scenario pins a similar two-tool composition through replayed model responses and a source or `lib` runtime, in a different required job. It cannot show what the deployed executable's shipped profile assembles for a Python caller.

## Consequences

A change to the minimal composition's model-visible surface — a system section, a tool, a tool description, or an added user message — now fails `python-runtime` with the exact diff, and landing it means rerunning `--scenario sdk-minimal --update-snapshots` and reviewing that diff. The minimal composition's tool descriptions become reviewed expected output.

Assistant and tool message text is not compared. The scenario's own assertions continue to own persistent-shell state, editor output, and the final response; the snapshot owns every model-visible message the profile emits.

[AGENTS.md](../../../../AGENTS.md) and [the testing policy](../../../../docs/testing.md) now name both SDKs as independent projections of the agent loop, session lifecycle, and `SessionEventMap`, so a change to any of those carries updating both expected outputs rather than only the one a contributor happens to run.
