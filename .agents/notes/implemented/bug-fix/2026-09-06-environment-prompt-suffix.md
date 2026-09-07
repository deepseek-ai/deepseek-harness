# Agent Note: Environment facts follow reusable prompt instructions

Status: implemented

English | [中文](2026-09-06-environment-prompt-suffix.zh.md)

## Problem

The local Web URL, Harness checkout path, and session cwd differ across users and machines. Placing those facts before reusable tool instructions makes otherwise identical prompts diverge near their beginning, limiting the prefix available for same-model cache reuse. The model-name introduction identifies the agent and can remain early.

## Decision

The [system-prompt registry](../../../../packages/core/system-prompt/README.md) keeps the fixed Harness identity first and `DEPLOYMENT_PERSONA_PREFIX` at `0`. First-party reusable instructions through `STRUCTURED_OUTPUT` precede the environment suffix: `HARNESS_SOURCE` at `10000`, `WEB_SURFACE` at `10100`, and `DEPLOYMENT_PERSONA_SUFFIX` at `10200`.

Global system-prompt config accepts `personaPrefix` and `personaSuffix`, both defaulting to empty. The [scoped persona row](../../../../packages/preset/persona/README.md) requires `prefix` and accepts `suffix`, defaulting to empty. They register `deployment:persona-prefix` and `deployment:persona-suffix` through the exported `PERSONA_PREFIX_SECTION` and `PERSONA_SUFFIX_SECTION` names. An omitted or empty scoped `suffix` shadows the global suffix away. The shipped Web, headless, SDK, and ACP bundles and standard, PTC, and Cordis presets keep the model introduction in the prefix and place only `Your working directory is {{cwd}}.` in the suffix. These names specify placement, not a classification of the text; no persona parsing or OS field is added.

The [prompt-variables and tool-guidance ownership note](../architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md) retains its identity-first persona placement, single-owner rule, strict interpolation, and tool-guidance responsibilities.

## Alternatives considered

**Move the entire persona late.** That moves the model-name introduction away from the beginning without helping same-model reuse. Separating cwd preserves the introduction and reusable instructions together.

**Move only the source path and Web URL.** Leaving cwd inside the early persona still breaks the reusable prefix across workspaces.

**Infer environment fragments from persona text.** Parsing deployment-authored prose makes placement depend on wording. Explicit templates give shipped compositions and custom deployments direct control.

**Move these facts into runtime-context messages.** That changes their message role and persistence placement rather than only separating system sections.

## Consequences

Byte-identical prefixes require the same model introduction, persona prefix, tools, configuration, and preceding section text. Arbitrary extension orders and assembly listeners remain authoritative; this is a first-party placement policy, not a universal stable-prefix guarantee. Provider cache sharing and hit-rate improvements are not measured or promised.

Environment and Web/source guidance follow structured-output instructions. A `complete: true` persona uses only the rendered prefix and ignores the suffix, suppressing every other system section without disabling tool schemas or runtime context. Source and Web facts retain their distinction between the Harness checkout, session workspace, and current working directory.

## Testing

[Registry tests](../../../../packages/core/system-prompt/tests/system-prompt.spec.ts) compare reusable prefixes with the same model and changed checkout paths, URLs, and cwd values; they also cover strict interpolation and complete overrides. [Loop tests](../../../../packages/core/agent-loop/tests/loop.spec.ts) pin early model identity and session-cwd interpolation. [Persona tests](../../../../packages/preset/persona/tests/persona.spec.ts) cover scoped suffix replacement, empty shadowing, and complete personas. [Recorded prompt snapshots](../../../../docs/testing.md) cover emitted prompts in native-tool and generated-SDK compositions; they do not measure provider cache hits.
