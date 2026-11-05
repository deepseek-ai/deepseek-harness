# Agent Note: Shipped filesystem mutation defaults

Status: implemented

English | [中文](2026-10-29-shipped-fs-mutation-defaults.zh.md)

## Problem

[Apply patch file editing](2026-09-28-apply-patch-file-editing.md) shipped `apply_patch` opt-in and kept `dsh-fs-observation-policy` mounted, so every base-backed profile refused `write`, `edit`, and `apply_patch` on a file the model had not read or that had changed since the read. Benchmark runs of the shipped compositions with the tool enabled and with the policy disabled were compared against the baseline, and the shipped defaults were decided from those results in discussion between the maintainers.

## Decision

- The `dsh-base` `tool-fs` row (headless, SDK, and ACP) and the Web `standard` preset state `applyPatch: true`. The Web `ptc` and `cordis` presets state `applyPatch: false`, and the shipped [PTC overlay](../../../../apps/cli/config/examples/ptc.yml) sets the same on the base row, so the SDK and Desktop PTC tool sets stay equal without a parity exception.
- The `dsh-base` `fs-observation-policy` row ships `disabled: true`. Every mutating tool in a base-backed profile runs against the bare provider: `write` overwrites, `edit` replaces the unique literal match, and `apply_patch` applies hunks on context match alone. A deployment restores the guard for all three with `disabled: false` on that row. `sdk-minimal` stacks no `dsh-base` and is unaffected.
- The `write` and `edit` guidance keeps asking for a prior read without naming the policy; the `apply_patch` guidance asks for enough hunk context to match one place instead of a prior read.
- The policy package is classified as an optional product package, since no default composition mounts it. The two recordings that capture a policy refusal, `fs-policy-reject` and `apply-patch-rejected`, re-enable the row through a per-scenario `runtime.cordis.yml`; the fixed-budget compaction scenarios pin `applyPatch: false` in both their live and replay patches because their thresholds were tuned to the recorded tool set.

## Alternatives considered

**Enable `apply_patch` only in the Web `standard` preset.** The SDK/Desktop parity check compares the SDK profile's `standard` tool set with the Desktop preset, so a Web-only change needs a permanent parity exception for a difference with no product reason; enabling the base row keeps the two equal.

**Disable the policy for `apply_patch` only.** A `tool-fs` switch that skipped the intent waterfalls for patches alone was built and evaluated, but it left `write` and `edit` under a guard the shipped compositions no longer wanted and added a second configuration axis beside the policy row; disabling the row decides all three tools in one place and keeps the policy package intact for deployments that want it.

**Enable `apply_patch` in the PTC presets too.** Under PTC the tool is a `run_code` binding rather than a JSON schema, so the cost is small, but the PTC compositions were evaluated without it; the overlay and the Web preset keep the evaluated tool set.

## Consequences

Default model requests in base-backed profiles carry the `apply_patch` schema and guidance, so every recorded request expectation outside the fixed-budget compaction scenarios changed. A model can overwrite or edit a file it never read; the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.2/fs-observation-policy-default-off/guide.md) names the one-line patches that restore the guard or drop the tool. Sandbox confinement, Review capture, and `fs/observed` events are unchanged.

## Testing

`tool-fs` unit tests cover the unguarded paths (`policy: false`). The keyless SDK smoke edits an existing file the model never read through the shipped `sdk` profile and checks the bytes on disk. `desktop-tools.expected.e2e.ts` compares the SDK and Desktop `standard` and `ptc` tool sets. The recorded corpus replays with the shipped defaults; `fs-policy-reject` and `apply-patch-rejected` replay with the policy re-enabled.
