# Agent Note: todo event types belong to their producer

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-20-todo-event-ownership.zh.md)

## Problem

`SessionEventMap` is merge-extensible so each plugin can add durable records without making the core session package depend on every event producer. `todo/write` and its `TodoItem` payload are produced and interpreted by the todo domain, while core session only provides the generic append, replay, surface, and invariant extension mechanisms. Declaring todo-specific types or relationships in core would make the session spine own a plugin vocabulary it cannot produce or validate completely.

## Decision

`@deepseek-ai/dsh-tool-todo` declares `TodoItem` and merges `todo/write` into `@deepseek-ai/dsh-session/types` from its type-only outlet. The package root and `/client` entrypoint re-export `TodoItem`, so host and browser consumers share one declaration without loading the todo plugin.

Consumers that inspect todo records use type-only imports plus explicit package dependencies and TypeScript project references. The emitted JavaScript has no todo import, and a composition does not need to mount the todo tool merely to search, transmit, or render a log that may contain `todo/write`.

The todo invariant companion owns both the payload rules and the event's relationship to an open turn. Core session's merge-extensible switch falls through for `todo/write`, while the todo companion rejects malformed snapshots and snapshots outside an open turn before append. It validates existing and newly announced sessions in one pass and advances a committed per-session turn trace for later events. Todo-specific append, replay, projection, and enclosure tests live with the todo package. The model-facing behavior remains owned by the [`todo_write` feature decision](../feature/2026-06-29-todo-write-tool.md).

## Verification

Focused todo tool, invariant, projection, integration, and Loader-composition tests exercise the producer and its companion. Session-query extraction and client runtime/connection tests prove type-only consumers retain semantic todo handling. Workspace typecheck proves declaration merging through the explicit project graph; generated event, persistence, API, and module catalogs record the declaration site and dependency edges.

## Alternatives considered

- **Keep the payload type in core as shared UI vocabulary** — rejected because rendering reuse does not make core the producer or semantic owner of the durable event.
- **Narrow `todo/write` structurally in each consumer** — rejected because duplicate payload declarations can drift and bypass the merge-extensible event map.
- **Require every consumer to mount the todo plugin** — rejected because reading a durable record is a type and data dependency, not authorization to install a model-facing tool.

## Consequences

The core session package does not export `TodoItem` or enforce todo relationships. A package that names or narrows `todo/write` declares a type-only dependency on `dsh-tool-todo`; consumers that treat unknown merged events generically need no dependency. The todo package is the single source for the event payload, client type, runtime validation, and open-turn rule.
