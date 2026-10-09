# Agent Note: Generate the CLI reference from command help

Status: implemented

English | [中文](2026-09-14-generated-cli-help-reference.zh.md)

## Problem

Launcher flags, profile options, and nested commands have separate owners. A manually maintained command reference can omit subcommands or retain obsolete defaults.

## Decision

The CLI reference captures the supported `dsh` launcher's help, the plugin forwarder's help, and each shipped profile's help, then recursively discovers the subcommands listed in each page's `Commands:` section. Shipped profile names come from `PROFILE_TEMPLATES`. Every page retains its complete help text; identical alias help appears once with all invocation forms.

Generation uses temporary Harness and Agents homes. Help exits before application work starts and requires no server or model. The plugin forwarder exposes its own help before pnpm arguments; flags after the pnpm command remain pnpm input.

The generated bilingual pages retain CLI output in its original language. `verify-cli-help` compares the complete pages and pairing record and runs with the documentation checks.

## Alternatives considered

A second command inventory or help-specific runtime API would duplicate the parser's definitions. Reading actual help keeps the reference tied to the same descriptions, options, defaults, and examples users receive.

## Consequences

Command changes update the reference through the same generator. Reviewers can compare complete help without assembling separate command invocations.
