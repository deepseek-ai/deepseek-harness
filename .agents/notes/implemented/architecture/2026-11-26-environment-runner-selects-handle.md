# Agent Note: Environment runners select the handle per run

Status: implemented

English | [中文](2026-11-26-environment-runner-selects-handle.zh.md)

## Problem

The [original environment note](2026-11-04-environment.md) bound one environment handle to each definition. Tools that choose the environment per call, such as `read(filename, host)` or a Session-selected host, then had to keep one runner per handle and look it up before every call. The handle took no part in what a definition sends or caches: the definition hash covers only `[source, methods]`, and the registry keys registrations and connections by the handle each call resolves.

## Decision

`ctx.environments.define(fn, { result, handlers })` fixes the function source, its result validation, its origin handlers and their names. The returned `EnvironmentRunner` takes the environment handle as its first parameter, followed by the arguments and `{ signal, confirm? }`. Each run resolves the registration that holds that handle when the run starts, so one definition made when a plugin loads serves every environment.

Handlers stay part of the definition. A caller whose handlers need host objects of one call still defines per call. This note partially supersedes the original note's decision that a definition binds its handle; the rest of that note remains active and cross-linked.

## Alternatives considered

- **Keep the handle in the definition and cache runners per handle in each tool.** Rejected: every tool that selects its environment per call repeats the same cache, although the registry already keys connections by handle and the definition cache by hash.
- **Accept both forms.** Rejected: two ways to name an environment add a public surface without a consumer that needs the bound form; a caller with a fixed environment passes the same handle on every call.

## Consequences

- Tools with per-call environments keep one runner per function instead of one per handle.
- The connection definition cache and its hashes are unchanged: equal definitions run in different environments reuse one hash, each connection receiving the definition once.
- Every call site names its handle, including tools that only use one environment.
