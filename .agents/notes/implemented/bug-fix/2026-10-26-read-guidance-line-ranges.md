# Agent Note: Read guidance names shell readers and line ranges

Status: implemented

English | [中文](2026-10-26-read-guidance-line-ranges.zh.md)

## Problem

The read guidance named only `cat` as the shell command the read tool replaces, and described `offset`/`limit` as continuing a large file rather than reading a line range. #6057 recorded a long Session reading ranges with `sed -n X,Yp` 60 times. #6054 added `sed`, `head`, `tail`, and the line-range wording; a later prompt revert removed them together with unrelated changes.

The 2026-10-23 evaluation of the SDK profile (native tools, six benchmarks) measured this sentence as the only change: Pass@1 mean −0.03pp and Pass@3 mean +0.70pp over the five benchmarks that report Pass@3 (ProgramBench-New has none) versus the base commit, with mixed step and token deltas (ProgramBench-New −15.5 steps, Terminal-Bench-v4 +13.5 steps). The PTC mode runs did not include this variant; the section renders in every request where `read` is visible.

## Decision

Restore the #6054 wording, byte-identical: `Use the read tool — not shell commands like cat, sed, head, or tail — to inspect text files. Use offset and limit to read a line range or continue a large file.` The read tool and its guidance are owned by `@deepseek-ai/dsh-tool-fs`; write and edit guidance are unchanged.

## Alternatives considered

**Rely on the read tool schema.** The schema already documents `offset` and `limit`, but #6057 shows the model chose `sed` while that schema existed; the guidance is the only model-visible place that names `sed`, `head`, and `tail`.

**Restore every prompt phrase reverted together with this sentence.** The subagent end-turn sentence, the `run_code` argument order, the PTC syntax ownership, and the SDK persona are separate decisions; the first is already restored ([subagent end-turn note](2026-10-21-subagent-end-turn-guidance.md)), and the others carry their own evidence.

**Say "line range" without naming shell commands.** The observed failure was choosing shell commands, so the sentence names them.

## Verification

- `packages/fs/tool-fs/tests/tools.spec.ts` asserts the rendered guidance text.
- Every recorded `system-prompt*.expected.md` sidecar that renders the read guidance carries the restored sentence: `test:snapshot` replays the session and SDK set, and `pnpm run test:web:ci` replays the `snapshots/web` set (the `node 24 / snapshots and artifacts` lane runs both). Two pinned historical sidecars (`web/cordis-tool-round`, `web/schedule-catalog`) retain their recorded text.
- The evaluation above measured this single change on the native SDK profile.

## Consequences

- Every request with the read tool carries three more command names and a line-range clause, about 10 tokens.
- The model is directed to the read tool for line ranges instead of `cat`, `sed`, `head`, or `tail`.
- The benchmark measured this sentence as neutral; keeping it rests on the #6057 production observation, not on a measured quality gain.
