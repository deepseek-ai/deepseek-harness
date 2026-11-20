---
description: "System-prompt assembly for users and maintainers adding prompt sections, variables, tool-schema sources, or configuring the model-facing prompt."
kind: "package-reference"
---

# @deepseek-ai/dsh-system-prompt

English | [中文](README.zh.md)

## Summary

`dsh-system-prompt` assembles ordered sections, runtime facts, variables, and tool schemas. Each Session receives only new or changed system text; unchanged instructions remain in history. Cordis lifecycle determines whether a registered source is active. Same-named registrations support scoped overrides. Invalid complete-prompt combinations and unresolved variables fail assembly.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `dsh-system-prompt` wherever agents run: it provides `ctx.systemPrompt`, the registry every prompt contribution lands in. Register through `agent.ctx` to contribute only to that agent. For the same section name, the nearest scope wins; within one scope, the latest live registration wins. Sibling scopes remain independent.

<a id="configure-the-prompt"></a>
### Configure the prompt

`sessionProjections` is required; activation awaits registration of the system-state projection.

The config owns the fixed opener, runtime context, deployment persona prefix and suffix, and tool order; everything else comes from registered contributions.

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
  config:
    includeHarnessIdentity: true
    includeRuntimeContext: true
    personaPrefix: 'You are the deployment assistant.'
    toolOrder: ['<unlisted-tools>']
```

| Field | Default | Meaning |
|---|---|---|
| `includeHarnessIdentity` | `true` | Include the fixed `You are an AI agent powered by DeepSeek Harness.` first-party opener at order −1000. Set false only when a compatibility deployment owns the complete system prompt. |
| `includeRuntimeContext` | `true` | Include optional ordered dynamic runtime context in assembly |
| `personaPrefix` | `''` | Global persona prefix template at order `0`, before first-party guidance |
| `personaSuffix` | `''` | Global `deployment:persona-suffix` template at order `10200`, after first-party guidance |
| `toolOrder` | — | Explicit model-facing tool order with one `'<unlisted-tools>'` rest entry |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-system-prompt) is the exhaustive source for every accepted field. A `toolOrder` list without exactly one rest entry or with duplicates fails at load; a listed name with no registered tool rejects every `assemble()`.

### Contribute a prompt section

Sections have a stable `name`, static or context-resolved `text`, and finite `order`.

Each section is trimmed after interpolation and before comparison, rendering, or logging, including literal and complete sections; interior whitespace is preserved. Whitespace-only changes send no update, and whitespace-only text follows empty-text admission rules. Replacement and retirement notices are trimmed too; retirement notices must remain nonempty.

The name identifies the same contribution across updates, plugin reloads, resume, and forks. Assembly sorts by order and then code-unit name. Repository contributors use `getSectionOrder()`; runtime context uses `getContextOrder()`. A `complete: true` section remains exclusive in assembly. Entering or changing it appends a notice superseding all earlier system-prompt sections from that point onward. Leaving it appends the current ordinary sections with the same prospective scope, including unchanged sections suppressed by the override. Earlier messages keep their positions; an empty complete prompt explicitly withdraws prior guidance.

```text
ctx.systemPrompt.section({
  name: 'tool:bash',
  order: 100,
  text: 'Prefer bash for file and process operations.',
})
```

Set `interpolate: false` on a section or dynamic context to preserve its text literally, including `{{…}}` groups in generated tool documentation or directory names. Other contributions interpolate variables by default.

`refreshContext(assembly, context)` refreshes registered runtime facts after pre-step and route preparation. It preserves accepted sections, tools, variables, and contexts contributed only by the assembly waterfall, applies current optional-context suppression, and restores missing required entries. Put changing facts in context providers; registered context text is read again before admission.

The agent loop calls `assemble(context)` before `agent/pre-step` for each proposed step, passing the Session, captured model selection (`context.modelSelection`), and admitted tool set (`context.toolSet`). The result fixes section text and lifecycle for that Session. Before each model attempt, the loop appends the writes returned by `assembly.systemUpdates(retry)`: ordinary deltas on the first attempt, and a rebuilt system head on the first attempt after compaction, including a retry. Retries reuse the assembly without reevaluating section callbacks. Rejection or cancellation before commit leaves committed admissions unchanged. Source changes after assembly wait for the next assembly. Presentation listeners receive sections, contexts, and variables; tools remain provider-owned.

Cordis teardown removes the exact registration, whether the returned disposer is called or the owning plugin unloads. Removing an override reveals the next live definition as an ordinary text update. Retirement occurs only when no live registration remains in the Session’s visible scope chain and that Session previously committed the name; the last disposed registration observed by the Session supplies its notice. Set `retirement` to a nonempty literal notice; omission uses `The earlier instructions from ${name} no longer apply.`. Retirement never evaluates a disposed producer’s callback. Disposing and re-registering the same name before assembly compares the new text with the committed text; identical text and order send nothing.

```text
ctx.systemPrompt.section({
  name: 'workspace:instructions', order: 100,
  text: () => currentInstructions,
  replacement: 'The workspace instructions have changed.',
  retirement: 'The workspace instructions no longer apply.',
})
```

### Contribute a prompt variable

Variables are referenced from section or context text as `{{name}}` and resolved at each assembly; scoped variables shadow a same-named global for that agent. The loop supplies `provider` and `model`; plugins can register the facts they own. The working-directory service supplies directory text as literal user context.

```text
ctx.systemPrompt.variable('response_language', () => 'English')
```

Custom persona templates must not depend on a built-in `{{cwd}}` variable: the loop does not register it, so unresolved references fail prompt assembly before any model request. Remove the `Your working directory is {{cwd}}.` clause from home, profile, or invocation `personaSuffix` settings and preset `suffix` fields, preserving unrelated text. Omit or clear an otherwise empty suffix. The [working-directory service](../../session/working-directory/README.md) supplies the required current-directory context.

### Contribute tool schemas

Tool-schema providers are evaluated per assembly and contribute the model-visible `ToolSchema` set; `ToolRuntime` registers itself automatically, so most tools need no manual wiring here. A provider returns the post-restriction visible set plus the pre-restriction name universe used by `toolOrder`.

### Suppress runtime context

`suppressRuntimeContext()` removes optional dynamic context for the calling scope without disabling the owning services. Contributions marked `required` remain visible. Multiple suppressors compose; optional context returns when none remains.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The package is a registry plus a cooperative assembly pipeline. One `assemble()` call merges the global layer with the requested scope's layer, detaches tool parameters, canonicalizes section order by number and then name, runs the scope-filtered `system-prompt/assemble` waterfall, restores an effective complete section as the sole prompt section, and applies any active runtime-context suppressor. Sections and dynamic contexts are separate inputs: sections become prompt text, while contexts become sourced user-role snapshots in model history under the loop. Tool schemas are part of the assembly by design — "what the model is told it can do" is one coherent thing, even though adapters transmit schemas as a separate wire field.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `SystemPrompt` service, config, assembly pipeline, `renderPrompt` |
| [`src/admission.ts`](src/admission.ts) | Fixed append or rebuild decisions from captured sections |
| [`src/projection.ts`](src/projection.ts) | Per-Session committed sections and pending compaction rebuilds recovered from the log |

### Assembly and rendering

In ordinary incremental assembly, omitting a previously admitted section from the waterfall result leaves its committed instructions unchanged. Return empty text to withdraw its instructions while keeping the source active, or dispose the registration to retire it.

Assembly captures source definitions and lifecycle state together, then resolves presentation through the waterfall. `PromptAssembly.systemUpdates()` compares the captured sections with the Session’s committed projection when called and returns `system/message` writes with their surface intents: appends for ordinary deltas, or replacements that rebuild one full prompt. Without `context.session`, it returns none. `renderPrompt()` renders the full presentation for inspection. Both paths interpolate variables unless `interpolate: false`, trim sections, and reject unknown or valueless references and malformed complete groups.

Logged `source.sections` entries carry `name`, `order` and `state`. An active entry requires `contentIndex` pointing to its canonical text block, even when that text is empty; a retired entry omits it. Optional `noticeIndex` lists the source’s replacement or retirement notice blocks. All indexes refer to the containing message’s `content` array, with no repeated indexes or overlap between text and notices. Whole-system supersession notices remain unattributed. Notices do not participate in text comparison.

Each section and notice occupies its own trimmed text block. Adapters choose separators when rendering these blocks. `source.reset` replaces committed section state. A logged compaction summary requires a full prompt from the sections that the next attempt’s assembly captured, including uncommitted changes, without replacement or retirement notices. This requirement survives discarded assemblies and restart until the [loop commits the rebuilt head](../agent-loop/README.md#understand-the-implementation); idle inspection retains the previous instructions until then.

The system projection retains committed sections and whether rebuilding is still required; a compaction summary or a system message without `source.sections` sets that requirement, and an attributed reset clears it. The Session surface reports the current system nodes from actual replaced positions rather than source citations. A rebuild reads the ordered system nodes, clears nonempty additions, and replaces the head last.

### Scoping

Assembly resolves section names from global to nearest scope, taking the latest live registration within each layer before evaluating text callbacks. Scoped contexts and variables shadow enclosing values; tool providers combine. Persona prefix and suffix use ordinary section registrations; the `persona` plugin overrides both, while a prefix-only registration inherits the suffix. The assembly waterfall dispatches scope-filtered. Registry-change notifications (`system-prompt/change`) are unfiltered because global changes affect every scope.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain.

- [System-prompt subsystem](../../../docs/subsystems/system-prompt.md) — the exact cross-package types and generated service API.
- [tools package](../tools/README.md) — the tool registry whose schemas flow into assembly.
- [Prompt variables Agent Note](../../../.agents/notes/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md) — who owns which prompt facts.
- [First-party prompt order Agent Note](../../../.agents/notes/archived/architecture/2026-08-25-sparse-first-party-prompt-section-orders.md) — the sparse named order allocation.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The first accepted assembly commits an initial `system/message` before user messages, including when every section is empty. Nonempty sections supply its text; an empty head remains in the log and surface but contributes no model-request message. Rejected assemblies and cancellation before commitment write no system head. Later admissions append changed text or order, with an optional `replacement` notice before new text. Omitting the notice names the replaced section; an empty notice suppresses that prefix. An explicitly empty text update uses its replacement notice, or a default retraction if none is supplied. A source sends its retirement notice only after every visible registration is disposed and only if previously committed in that Session, then leaves the committed projection. At the next accepted request after compaction, assembly evaluates active sources again and commits their current instructions at the head, including changes since the last ordinary admission. Runtime context remains a separate sourced user-role snapshot.

##### Harness identity

```markdown
You are an AI agent powered by DeepSeek Harness.
```

#### Token effect

Ordinary updates add only a changed section and its notice. After compaction the next request receives the current system head, with notices and superseded instructions removed from the retained conversation.

#### KV Cache effect

Ordinary updates preserve earlier messages. Route changes, resume, explicit request-series starts, and tool-schema changes do not consolidate sections. Compaction replaces the selected range with a summary; the next model attempt consolidates current instructions at the head. The next ordinary admission compares source values with that committed head. Adapters choose native in-history messages, reminder messages, or a combined system field according to route support; only representations preserving the prefix can reuse its cache.

### Tool schemas

#### What the model sees

For shipped tools, the model receives the per-agent-visible subset of the [generated tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-executor-ptc), ordered by configuration or lexicographically after restrictions and step-time activation. Extensions can contribute additional definitions through the same registry. Sections and schema providers are separate assembly inputs. A restriction does not remove a section registration: tool-guidance plugins use `text({ scope, toolSet })` and `ctx.tools.get(name, scope, toolSet)` to return empty text or select applicable fragments. Arbitrary static sections are not automatically rewritten.

#### Token effect

Schema tokens repeat on every request. Restricting a tool removes its entire schema cost for that agent but not a separate prompt section; reordering changes cache shape but not semantic content.

#### KV Cache effect

Prefix-stable while the visible schema set, rendering, and order are unchanged. Registration, restriction, or reordering may invalidate reuse from the first changed schema token.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when prompt assembly needs special care. They are current package constraints, not a task backlog.

- **Deployment-authored text comes from configuration/composition only**: this plugin registers deployment persona defaults; composition plugins override their section names through `section()`. Other sections belong to the plugins that own those facts. There is no end-user prompt editing API.
- **Source lifecycle is process-local**: an app restart loses disposed source definitions not yet committed as retirement. Earlier guidance from a source absent after restart can remain in resumed history.
- **No inline escape syntax in interpolated text** — use `interpolate: false` when a whole section must preserve literal braces.
- **`toolOrder` misconfiguration surfaces at prompt assembly (the first turn), not at boot** — only shape violations throw at config load.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
