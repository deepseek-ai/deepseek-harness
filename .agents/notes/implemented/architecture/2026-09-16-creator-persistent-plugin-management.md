# Agent Note: Creator mode installs persistent plugin bundles

Status: implemented

English | [中文](2026-09-16-creator-persistent-plugin-management.zh.md)

## Problem

Agents need to install capabilities and use them during the same conversation. Generated-code tools create a second plugin lifecycle alongside ordinary installed bundles.

## Decision

Creator mode enables the existing `plugin_manager` tool. Agents author packages and Loader YAML patches as workspace files, then install them through `install_bundle`. An MCP connection is a configuration-only bundle inserting the installed `dsh-mcp-client`; a UI bundle includes a Host entry and a Client artifact. Profile locking, package installation, enablement and HMR remain owned by the existing manager. The entire management tool requires `danger-full-access` or approval for one call: profile changes can load code with host permissions and affect other sessions. Each execution, including inventory reads, uses the shared sandbox escalation helper and approval service before accessing the manager. Under lower sandbox modes, `ask` requests approval and `never` denies; a full-access session needs no additional approval. A grant does not change session permissions, but its profile changes persist. This keeps shell-equivalent Host access explicit without requiring a permanent session-wide elevation. Human-operated Web and CLI controls retain their existing behavior.

The model sees two read-only Cordis inspection tools. Generated-code define/run/stop/undefine and dynamic self-inspection tool APIs are absent. Existing runtime and Client consumers retain their services; historical session cards remain readable. This supersedes only the model-facing mutation workflow in the [self-referential toolset decision](../feature/2026-07-08-self-referential-cordis-toolset.md); its runtime ownership and sandbox rationale remain independently relevant. The [profile transaction decision](2026-09-14-current-profile-plugin-management.md) continues to govern locking, package installation, and partial failures.

Visual creation requests default to an installed Client plugin rendered in the current Web page unless the user names another destination. The development skill supplies a minimal package and effect-owned Client registration. Discovery ends when the required APIs are known; a working first version is installed before optional visual refinement. Verification uses the connected page where available. Browser authentication or operating-system setup is not a prerequisite for plugin installation, and a mock preview cannot establish an in-app result.

Desktop supplies its bundled pnpm entry and Electron Node invocation through launcher-owned profile facts. Plugin Manager uses that invocation for installation, removal, and registry inspection, retaining the ordinary profile transaction and activation behavior. Its environment applies only to package subprocesses; ordinary Host subprocesses do not inherit the private Node launcher path. CLI profiles retain their configured PATH command.

Historical Cordis sessions declare `retired-tools` coverage at their exact format version, including when it equals the current writer. They are immutable replay inputs; their tool call/result data is compared after persistence and their cards render without registering retired tools. This coverage does not count toward migration coverage. The retained runner write APIs remain for programmatic and browser consumers; removing them requires replacing those consumers together.

## Alternatives considered

Generic entry CRUD and an MCP-specific management API duplicate operations expressible as bundle files plus existing installation and enablement. They are unnecessary for prompt-driven installation. Moving generated-code versioning into Plugin Manager retains two lifecycles without providing ordinary package persistence.

## Consequences

Selected bundles affect all sessions in the profile and survive restart. HMR activates new bundles on live profiles; installed package replacement requires restart. The agent reports saved state separately from activation and verifies the requested capability. Side effects belong to the plugin lifecycle, including stylesheet cleanup.

A built Web profile test installs an MCP bundle, checks existing and new Creator sessions, restarts the process, and verifies tool disposal after bundle removal. A recorded session replays manager enablement of a configured MCP entry followed by an actual local MCP request without model credentials. Historical-card tests retain the removed tools' saved presentation.
