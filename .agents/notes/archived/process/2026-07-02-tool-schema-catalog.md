# Agent Note: Generated tool-schema catalog (boot-and-harvest)

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-02-tool-schema-catalog.zh.md)

## Problem

The repository had no single reference for the names, descriptions, and JSON Schemas actually exposed to the model. Source declarations are scattered and runtime-composed, while the existing Cordis reference and subsystem pages cover wiring and vocabulary rather than tools.

## Decision

Generate the catalog by **booting each tool plugin and reading its registered schemas**, not by parsing source. `scripts/gen-tool-catalog.ts` mounts each shipped tool package on a fresh cordis `Context` (with `SystemPrompt` + `ToolRuntime` and the injected services the plugin's `apply` reads), calls `ctx.tools.schemas()` — exactly the `ToolSchema[]` the model is sent — disposes the context, and renders one `## <package>` section per package with a ` ```json ` `parameters` block per tool. It mirrors the `gen-cordis-catalog` / `gen-module-graph` CLI shape: default `--write` regenerates, `--check` fails if the committed copy is stale, output is deterministic (manifest-ordered, tools sorted by name). `verify-tool-catalog` (the `--check`) runs inside `doc-sync`, so relevant documentation changes and CI exercise the same freshness check.

### Why boot, not parse (the crux)

The cordis catalog is a pure TypeScript-AST pass because every event/service name is a string literal that round-trips to a static declaration — the AST is the whole truth. **Tool schemas are not statically knowable**, so the same technique would produce a doc that lies:

- `tool-todo` writes `enum: [...STATUSES]` — a spread of a runtime `const`. The AST sees the spread expression, not `["pending","in_progress","completed"]`.
- Every description is built by string **concatenation** (`'…' + '…'`). The AST sees concatenation nodes, not the final prose the model reads.
- `tool-subagent`'s tool name is `config.toolName ?? 'subagent'` — chosen at load, not a literal.
- An MCP plugin can register **raw JSON Schema** directly via `ctx.tools.register()` without `defineTool` at all, so enumerating `defineTool(` call sites structurally under-counts.

The only faithful source of truth is the schema the registry actually holds after the plugin loads. Booting is the [testing-policy discipline](../../../../docs/testing.md) "verify the world, not the self-report" applied to a doc generator: read the shipped artifact, not a re-derivation of it.

### Restoring "nothing silently omitted"

Booting has a cost the AST pass did not: there is no source declaration set to enumerate, so a new tool package could simply be forgotten. A **completeness guard** restores the guarantee — `assertManifestComplete` globs every `tool-*` package under `packages/` and hard-errors if any is absent from the generator's boot manifest. A new tool package fails the generator, and therefore `doc-sync`, until it is registered. This is the same structural property the cordis generator gets for free from enumerating source, re-created for a boot-based generator.

### A hand-maintained boot manifest is the irreducible policy

The filesystem discovers the tool-package inventory and the completeness guard rejects omissions. `TOOL_PACKAGES` still owns an explicit boot recipe for each package because required Service Providers and config are policy, not facts that can be inferred safely from layout or injection names.

### Scope

Shipped product tool packages under `packages/*/tool-*`, each booted with its default config, including `dsh-tool-bash` (`bash`), `dsh-tool-jobs` (`job_output`, `job_list`, `job_kill`), and `dsh-tool-subagent` (`subagent`). Example-only tools are excluded.

The catalog unit is a package, not every configured tool instance. Each package boots once with default config; load-time aliases such as `subagent_fork` are noted without enumerating every deployment permutation. A deployment inventory is a separate, unbounded surface.

### A plain `json` fence

Schema blocks use ` ```json `, not a bespoke `ts`-family fence. `doc-typecheck` only extracts `ts*` fences, so a JSON block is invisible to it — no `BlockKind` wiring is needed (unlike the cordis catalog's `ts cordis-catalog` fence, which had to be allowlisted so a bare signature fragment isn't compiled).

## Alternatives considered

- **A pure TypeScript-AST pass, like the cordis catalog** — tool schemas are not statically knowable (the crux above): runtime spreads, string concatenation, config-chosen names, and raw `ctx.tools.register()` registrations all make an AST-derived doc lie.
- **Inferring each package's boot recipe from its injects** — the "too clever" path [the discover-package-inventory proposal](../../proposed/process/2026-06-20-discover-package-inventory.md) warns against; the recipe stays hand-written policy while the inventory is discovered and completeness-guarded.
- **A bespoke `ts`-family fence for schema blocks** — unnecessary: a plain ` ```json ` fence is invisible to `doc-typecheck`, so no `BlockKind` allowlisting is needed.

## Consequences

- The catalog cannot drift: a tool schema change the committed file doesn't reflect fails `verify-tool-catalog` in `doc-sync` and CI. A new `tool-*` package not added to the manifest fails the completeness guard outright.
- Tool description prose has a single home — the `defineTool` `description` at the source — and the generated entry is only as good as it, the same forcing function the cordis catalog applies to event JSDoc.
- The generator imports and executes workspace packages (the first repo script to do so; the others only read text). It runs under `tsx` via the root `tsconfig` `paths` map, the same unbuilt-source path the demos and tests use, so it needs no build step.
- A new capability seam behind a future tool means a new manifest recipe entry (which seams to mount). This is the deliberate hand-written cost called out above; it changes only when a tool package is added.
