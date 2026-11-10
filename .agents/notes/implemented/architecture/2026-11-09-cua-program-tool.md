# Agent Note: CUA programs outside the PTC preset

Status: implemented

English | [中文](2026-11-09-cua-program-tool.zh.md)

## Problem

Computer Use needs reusable application and window objects in Standard and other presets without changing their ordinary tool calls or requiring users to change the profile's PTC runtime. Experimental CUA packages cannot appear in shipped preset definitions. Program dispatch must retain the same permission checks, cancellation, nested logs, and screenshots as PTC.

## Decision

CUA keeps `agentPreset: ptc` as the default selector for its raw `cua` tool. Every other composed preset receives `cua_run_code`; Agents without a composed preset receive neither tool. `agentPreset: false` retains global raw-tool registration. A base owner uses Agent scopes for registration and disposal, so enabling and disabling the provider affects existing and later Agents without editing presets. Raw registration depends only on base CUA services and preset selection. The private program producer publishes and withdraws its definition by identity; private dependency loss or startup failure leaves raw tools and prompts available.

`cua_run_code` composes the shared [program-tool factory](../../../../packages/core/tool-executor-ptc/README.md) with one isolated Node `persistent-in-memory` runtime owned by the CUA provider. Agent `stateOwner` identities select separate retained processes. Its only binding is the private `tools.cua` definition; the model calls ordinary session tools directly. Nested CUA operations retain tool policy, guards, dispatch events, and image admission. The provider releases held keys when either program tool settles. Provider unload drains its own CUA programs before native teardown; releasing input held by other PTC programs does not wait for their unrelated work. State is in memory, separate from the profile's PTC state, and released with its Agent or provider.

CUA registers a source program through `registerEnvironmentInitializer` before its isolated runtime admits a run. Each new environment evaluates it once after installing current bindings, including temporary escalated environments. The child awaits Host acceptance before starting model code. Initialization shares the first run's time and output budgets; failure discards the environment and prevents model execution without rolling back external effects. Separate evaluation preserves model source locations. An initializer-owning scope depends only on the runtime, so program-tool dependency reloads retain the registration. PTC keeps its explicit bridge initialization.

This partially supersedes the exclusion of a CUA program entry in [native CUA objects](2026-09-17-experimental-cua-object-api.md). That note still owns the object API's independence from an evaluator and the split between shared objects and native operations. The shared Node provider owns evaluation; CUA supplies its restricted bindings and initialization. The [optional bundle decision](2026-09-21-experimental-capabilities-as-optional-bundles.md) still owns delivery and activation.

## Alternatives considered

**A CUA-specific evaluator** duplicates execution lifecycle policy. Reusing the PTC factory and runtime keeps cancellation, limits, sandboxing, and result handling with their existing owners.

**The profile's shared runtime** couples CUA state to unrelated PTC and workflow settings. Its default per-call mode cannot retain objects. A separate CUA runtime preserves the profile's chosen execution mode.

**Global registration of both tool forms** exposes a program runner inside PTC programs and exposes raw CUA calls to other presets. Selecting one form per Agent keeps each mode's intended tool list. Binding every session tool inside `cua_run_code` would duplicate ordinary direct calls and their declarations.

**Prepending initialization to model code** shifts source locations. Running initialization as a separate tool call fails for temporary escalated environments because the next call starts another process. A separate program within the first runtime execution supports both retained and temporary environments. Passing initialization with every program couples environment setup to tool requests and repeats work in existing environments; registration keeps setup and cleanup with the runtime owner.

## Consequences

CUA adds no preset list or shipped preset dependency. Preset IDs select the tool form; custom PTC presets must match `agentPreset`. PTC and CUA share the public factory; CUA owns a runtime initializer registration and drains its program tools before unregistering it. Older custom Node bootstraps require the matching protocol revision, as described in the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.1/ptc-bootstrap-protocol/guide.md).

The private binding limits callable Harness tools, not Node APIs. File and process access still follow the selected sandbox policy. Retained variables do not reserve applications or survive process loss; callers recreate objects and observe state before continuing. Composition and recorded-session tests cover tool selection, automatic initialization, retained state, nested output, and removal; native fixtures remain responsible for platform input behavior.
