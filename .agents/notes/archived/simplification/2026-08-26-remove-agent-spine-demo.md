# Agent Note: Remove the agent-spine demo package

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-26-remove-agent-spine-demo.zh.md)

## Problem

`@deepseek-ai/dsh-agent-spine-demo` was named and located as an example but exposed a public composition plugin with a large merged configuration. Its only shipped consumer was `dsh-sdk-minimal`, where one plugin row hid the mandatory agent runtime from a bundle whose purpose is a complete explicit tree. Every other consumer was a test. The package also duplicated composition policy already owned by `dsh-base` without providing a capability that could evolve independently.

## Decision

The package, its public configuration, and the `packages/examples` group are deleted without an alias. `dsh-sdk-minimal` now declares timer, LLM, session, title, system-prompt, tools, agent, retry, local jobs, invariant registry and companions, and agent-loop rows directly in its patch. It still omits workspace instructions, skills, model-facing job tools, goals, subagents, settings, and the other `dsh-base` features.

Profile integration tests load the shipped profile and bundle patches through `loadProfile`, then pass the production patches and narrow test `*.patch.yml` files to the same root `cordis:include` used by application boot. Test patches cover a mock provider or model, isolated persistence, and the plugin under test without recreating the mandatory agent tree. SDK server unit tests that do not exercise profile integration mount `dsh-agent-loop-testkit` and `dsh-agent-loop` locally.

## Verification

The `sdk-minimal` bundle test checks its exact row inventory and owner configurations, and the built CLI test checks the emitted profile tree. Real-Loader fixtures exercise the shipped bundle layers with test overlays, while SDK server tests exercise the package-local testkit composition. Configuration, package, invariant, generated-document, build, hygiene, and snapshot gates verify that no live product or test imports the deleted package.

## Alternatives considered

**Replace the package with `dsh-base`.** Rejected because `dsh-base` is the full product foundation, while `sdk-minimal` deliberately omits its settings, credentials, workspace context, skill, goal, compaction, telemetry, subagent, and broad tool rows. Replacing the package with base would change the profile instead of removing indirection.

**Rename and move the public composition package.** Rejected because no two shipped products share that composition. A renamed package would preserve the merged configuration forwarding and hide the row owners from profile patches.

**Keep a private mandatory-runtime composition for tests.** Rejected because a private TypeScript tree still duplicates production composition policy and can drift from the shipped profile. Test overlays remain explicit without owning the rows they do not change.

## Consequences

The pre-release package import and its merged configuration are removed. `sdk-minimal` becomes longer but every mounted feature is individually visible and patchable. `dsh-base` remains the full product composition and cannot substitute for the smaller tree. Profile integration tests now change when the shipped base or mode bundle changes, so their Loader and recorded-session coverage reflects the production tree instead of a parallel test composition.
