---
description: "Session-log snapshot support for keyless profile tests: manifests, identity redaction, normalization, workspace checks, and protocol adapters."
kind: "package-library"
---

# @deepseek-ai/dsh-session-snapshot

English | [中文](README.zh.md)

## Summary

`dsh-session-snapshot` provides the shared support behind keyless recorded-session tests (`pnpm run test:snapshot`): closed manifests, typed identity redaction, normalization, workspace comparison, fixture guards, and protocol adapters for headless, SDK, ACP, and Web owners. The ACP adapter launches the tested profile as a real subprocess, drives a deterministic input script, and registers the complete record, replay, and refresh suite. Every scenario owns enough committed evidence to prove model-visible output and filesystem effects without trusting the agent's report. The package entry imports vitest and is therefore available only inside a vitest run.

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

This package turns a shipped profile scenario into a keyless snapshot suite: write a scenario table and a fixtures directory, call the matching adapter once, and the kit owns launching or composing the profile, driving the scenario, comparing normalized output, and guarding the committed fixtures.

### Writing a snapshot suite

A consuming `*.snapshot.ts` is the scenario table plus one factory call. `AgentUnderTest` supplies absolute `binScript`, optional `libBinScript`, `configPath`, and `tsconfigPath` paths, because the subprocess cwd sits outside the repository:

```ts
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineAcpSnapshotSuite,
  type Scenario,
  type SnapshotSuiteOptions,
} from '@deepseek-ai/dsh-session-snapshot'

function snapshotMode(value: string | undefined): SnapshotSuiteOptions['mode'] {
  switch (value) {
    case undefined:
    case '':
    case 'replay': return 'replay'
    case 'record': return 'record'
    case 'refresh': return 'refresh'
    default: throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

const SCENARIOS: Scenario[] = [
  { name: 'text-turn', hasModelTurn: true, recorded: true, pinsHeader: true },
]

defineAcpSnapshotSuite({
  agent: { // absolute paths, resolved from the suite's own location
    binScript: fileURLToPath(new URL('../../../apps/cli/src/bin.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
    profile: 'acp',
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  },
  snapshotsDir: join(dirname(fileURLToPath(import.meta.url)), 'snapshots'),
  scenarios: SCENARIOS, // exactly one entry per header class sets pinsHeader
  mode: snapshotMode(process.env.DSH_SNAPSHOT),
})
```

Each recorded-session directory carries a closed `snapshot.yml` manifest plus canonical parent and contiguous child roles. Parent filenames are `session[.vN].jsonl`; children are `session.<ordinal>[.vN].jsonl`; v0 omits `.v0`, positive versions use lowercase `.vN`, and every filename agrees with its header. A role may retain older generations, but the harness selects the numerically highest one. An owning manifest may declare `sessionFormat.version` plus one or more closed `coverage` names to keep that historical generation as an explicit migration fixture; absence tracks the current writer. The manifest also names the scenario, shipped profile, composition/header class, recording source, and only the replay, platform, permission, environment, workspace, or input facts the completed Session cannot reconstruct. The adapter registers expected-output, Session-log, and optional `workspace.expected/` comparisons; guards reject orphan directories, missing roles, noncanonical names, absolute paths, malformed manifests, and platform-specific separators.

`normalizeSessionSnapshot` retains the complete Session header and event payloads but omits top-level `seq`/`time` envelopes from committed fixtures after normalizing paths and scrubbing request headers; it also normalizes embedded stream clocks and historical packed-row `seq0`/`time0` envelopes. Replay synthesizes the top-level envelopes in memory, while runtime persistence continues to write complete logs. Multi-session comparison restores every selected persisted or projected fixture through the current build-static Session format catalog before identity redaction and normalization, so retained v0/v1 replay input and fresh `session.v2.jsonl` writer output compare as one v2 logical Session without rewriting or renaming historical files. Expected and harvested logs use the same strict restoration path; source filenames cannot alter format validation. Versionless protocol-adapter unit fixtures remain outside the released Session format corpus. Current v2 fixtures use one row per event; retained v0/v1 fixtures may use canonical packed rows. The [temporary repository migrator](../../../scripts/migrate-packed-session-fixtures.ts) (`pnpm run migrate:packed-session-fixtures`) rewrites older historical layouts, and its [removal proposal](../../../.agents/notes/proposed/process/2026-07-26-remove-packed-session-fixture-migrator.md) owns its deletion.

### Record, replay, and refresh

`pnpm run test:snapshot:record` calls the live LLM and writes the harvested current generation under its canonical versioned filename. Record and refresh never rename or delete a completed generation, including generations of a child role absent from a later run; reviewed source-tree curation removes a predecessor only after the same role has a verified current replacement. Scenarios with an explicit `sessionFormat` remain read-only in record mode. `pnpm run test:snapshot:refresh` stays keyless, runs the selected highest replay input, and writes stdout, owned prompt and tool-schema sidecars, and a fresh current-generation comparable Session output unless the manifest retains a historical generation. Each composition owner keeps its replay patch beside its live patch; top-level `snapshots/` owns Session-driven scenarios, while other expected outputs stay beside their owning package. [`dsh-llm-replay`](../llm-replay/README.md) serves the recorded streams selected through `DSH_SNAPSHOT_*` environment values.

### Pinning request headers

A pin owns its generated `system-prompt.expected.md` or `tool-schemas.expected.json` sidecar by default; `systemPromptSource` and `toolSchemasSource` name another pin when the complete corresponding sequence is identical, so each distinct version is committed once. The selected highest parent fixture stores `"system":"{{system}}","tools":"{{tools}}"` while retaining config, reason, and any model-visible prefix. A child Session whose own scope composes a different request declares it per fixture index with `pinsChildToolSchemas` and `pinsChildSystemPrompts`. A scenario that changes the request header mid-run declares `expectedHeaderChanges`.

### Platform and composition variants

A scenario requiring a non-Windows host declares `posixOnly`, which skips its run test on Windows while the fixture guards keep covering its committed files everywhere; a scenario whose composition needs a usable `pwsh` declares `pwshOnly`. `workspaceParent` moves the generated child cwd outside the platform temp directory when temporary-directory grants are themselves under test; a scenario's committed `workspace/` is copied into that child first, then `prepareWorkspace` runs against the generated cwd before the agent starts. Default generated workspaces are stored in session fixtures as `{{cwd}}`, so platform temp roots and random basenames do not affect recordings.

### What can go wrong

- **A fixture guard rejects the committed files** — orphan scenario dirs, missing files, multiple pins for one header class, duplicate sidecar content, unscrubbed JSONL headers, and malformed pinning headers all fail the suite before comparisons run.
- **The session harvest needs raw JSONL mode** — snapshot configs set the JSONL backend's `compression: 'none'`; compressed JSONL has no snapshot-harvest path.
- **Built mode needs current artifacts** — run `pnpm run build` before selecting `DSH_EXAMPLE_MODE=lib`; source mode remains the zero-build path.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the kit; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design

The shared core owns manifests, generation-qualified role selection, workspace setup/comparison, typed identity mapping, normalizers, and fixture invariants. The ACP adapter adds four composable layers: launcher, scenario harness, normalizers, and suite factory. `launchAcpTestAgent` boots a source profile under tsx or a built `lib` profile under plain Node, connects the SDK client over a raw-byte stdout tee, collects Session updates and stderr, fails closed on unhandled permission requests, and owns shutdown. `runScenario` drives ACP JSON-RPC stdio and harvests the numerically highest persisted raw JSONL generation for every Session directory. The pure normalizers replace cwd paths and typed identities with stable tokens, zero times, expand physical provenance ranges, and scrub request-header bulk. `defineAcpSnapshotSuite` registers comparisons, generation-qualified fixture write-back, and the live uniformity guard.

### Source map

| File | Role |
|---|---|
| [`src/launcher.ts`](src/launcher.ts) | Subprocess/client launcher and shutdown ownership |
| [`src/harness.ts`](src/harness.ts) | Scripted scenario driver and session-log harvest |
| [`src/manifest.ts`](src/manifest.ts) | Closed `snapshot.yml` schema, collection, and ownership rules |
| [`src/session-files.ts`](src/session-files.ts) | Canonical parent/child generation grammar, header agreement, and highest-role selection |
| [`src/identity.ts`](src/identity.ts) | Typed first-seen identity tokenization across parent and child logs |
| [`src/normalize.ts`](src/normalize.ts) | Pure normalizers and scrubbing helpers |
| [`src/workspace.ts`](src/workspace.ts) | Scenario workspace setup and complete expected-state comparison |
| [`src/suite.ts`](src/suite.ts) | Scenario-table suite factory, fixture guards, record/refresh write-back |
| [`src/index.ts`](src/index.ts) | Package entry re-exporting the four layers |
| — | No runtime invariant companion is published; this test-support package owns no production event stream or mutable data; consuming test suites exercise its behavior. |

### Data flow

A scenario runs the agent under the launcher, feeds it the input script through the harness, and captures stdout plus the persisted logs. The normalizers canonicalize those captures — ids to first-seen sequence, generated cwd to `{{cwd}}`, header bulk to `{{system}}`/`{{tools}}` — so recorded and fresh runs compare structurally. The factory then compares normalized stdout and re-persisted logs against committed fixtures, or writes them back in record/refresh mode, and its guards reject malformed or drifting fixtures before any comparison result is trusted.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the snapshot kit to the model fixture source, the launch mechanics, and the policy that requires the tier.

- [llm-replay](../llm-replay/README.md) — the keyless model fixture source replay mode consumes.
- [loader-smoke](../loader-smoke/README.md) — the mode-aware subprocess launch mechanics the launcher builds on.
- [Testing policy](../../../docs/testing.md) — the keyless snapshot tier, when it is required, and the fixture ownership rules.
- [Test-support group map](../README.md) — sibling harnesses and support packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this test-only support records, normalizes, and compares profile sessions without changing the agent's assembled model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the kit needs special care. They are current package constraints, not a task backlog.

- **Session harvest requires raw JSONL mode** — `runScenario` collects persisted `.jsonl` logs, so snapshot configs set the JSONL backend's `compression: 'none'`; compressed JSONL has no snapshot-harvest path.
- **Built mode requires current artifacts** — run `pnpm run build` before selecting `DSH_EXAMPLE_MODE=lib`; source mode remains the zero-build path.
- **ACP remains for protocol behavior** — cancellation and permission round trips whose stimulus is the ACP client stay on that adapter; assembled one-shot and persistent-control behavior uses headless and SDK adapters.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
