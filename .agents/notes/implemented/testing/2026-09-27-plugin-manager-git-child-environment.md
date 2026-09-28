# Agent Note: Plugin-manager Git children isolate the host's command-line configuration

Status: implemented

English | [中文](2026-09-27-plugin-manager-git-child-environment.zh.md)

## Problem

The self-hosted Windows serial lane failed 13 cases in run 36227311113 (job 108363684565); 12 share one cause: [github-connection.spec.ts](../../../../packages/boot/plugin-manager/tests/github-connection.spec.ts) 9 (the six install-address forms and three proxy cases) and [manager.spec.ts](../../../../packages/boot/plugin-manager/tests/manager.spec.ts) 3 real-Git install cases. The host carried Git's indexed command-line configuration — `GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`, the group Git hands to `git -c` calls and their hook children. The shared subprocess scrub (`scrubbedParentEnv`) removes credential-shaped names, so it stripped the key and kept the counter; Git reads the counter first, and every child died with `error: missing config key GIT_CONFIG_KEY_0` / `fatal: unable to parse command-line config` (exit 128) before opening any configuration file.

## Decision

Both spec files delete Git's command-line configuration group from their own process environment before they spawn Git, through [isolateGitCommandLineConfig](../../../../packages/boot/plugin-manager/tests/git-environment.ts). These specs judge profile behavior — profile Git configuration, real installs — rather than host state, so a host that exports the group no longer changes their outcome. The helper restores the removed entries after the file with `vi.stubEnv(name, undefined)` and `vi.unstubAllEnvs()`.

## Alternatives considered

**Remove the group whole in `scrubbedParentEnv`.** The product-side fix treats the counter and its keys as one unit, but it changes shared subprocess behavior for every consumer, which the review directive for this change excludes. It is preserved on the branch `deferred/git-command-line-config-scrub-20260927` for a future product PR with its own justification.

**Pin `GIT_CONFIG_COUNT: '0'` at the plugin-manager call sites.** `packages/deliverables/workspace-changes/src/git.ts` does exactly that for its children, so the same two lines in `github-connection.ts` and `operations.ts` would cover this class. That is still a product behavior change, so it stays out of scope here.

**Clear the group in the lane's workflow.** The group reaches the job from the host image rather than from a step this repository owns, and other Git-spawning specs would stay exposed.

## Verification

`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.bare GIT_CONFIG_VALUE_0=true pnpm exec vitest run packages/boot/plugin-manager/tests/github-connection.spec.ts packages/boot/plugin-manager/tests/manager.spec.ts` fails 12 cases at the parent revision with the lane's assertion set and passes 95/95 with the isolation in place.

## Consequences

The two specs pass on a host that exports Git command-line configuration. The product's treatment of such hosts is unchanged, so the same environment still breaks any other consumer of the shared scrub; a future product change to `scrubbedParentEnv` must revisit this note.
