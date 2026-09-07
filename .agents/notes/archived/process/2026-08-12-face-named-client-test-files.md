# Agent Note: Face-named client test files

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-12-face-named-client-test-files.zh.md)

## Problem

`packages/client/*/tests/` holds tests for both compile faces. Most cover a Client package's browser half and belong to `tsconfig.client.json`; a few cover the Host half of a split package — the carrier's node-half specs — and can only type-check in `tsconfig.host.json`, because a Host-face spec reaching Host source needs the Host projects those files live in.

Nothing in a filename said which face a test covered, so the two aggregates could not partition the directory by pattern. The host aggregate excluded `packages/client/**` wholesale and the Client aggregate took everything, which left the Host-face specs in the Client program. They then needed the Client aggregate to reference `packages/client/connection/tsconfig.host.json` — a Client config entering a split package's Host face, which the `constraints` project-reference rule rejects.

Two escapes exist without a naming rule, and both are worse. Carving the four files back with `files` entries in the host aggregate contradicts the wholesale exclusion in the same file and grows with every new Host-face spec. Allowing the cross-face reference weakens the rule that keeps the two `Context` merges apart.

## Decision

A test file under `packages/client` names the face it covers:

| Suffix | Face | Count |
|---|---|---|
| `*.client.spec.ts` / `*.client.spec.tsx` | Client | 232 |
| `*.client.ts` / `*.client.tsx` (shared helpers, fixtures) | Client | 5 |
| `*.host.spec.ts` | Host | 4 |

The suffixes are mutually exclusive — neither is a suffix of the other — so each aggregate keeps one broad test glob and excludes the other face:

- `tsconfig.client.json` includes `packages/client/*/tests/**/*.{ts,tsx}` and excludes `packages/client/*/tests/**/*.host.spec.ts`.
- `tsconfig.host.json` reaches the same directory through its repository-wide `packages/*/*/tests/**/*.ts` and excludes `packages/client/*/src/**` plus the four `*.client.*` patterns.

This rests on `exclude` filtering the result of `include`: when both match, the file stays out. No file is named in both aggregates, and neither aggregate needs a `files` entry or a cross-face project reference. `verify-md-links` and the `constraints` project-reference rule pass unchanged, with no exception for the carrier.

A new test under `packages/client` must carry a face suffix. An unsuffixed file is matched by the host aggregate's package glob and silently pulls Client source into the Host program.

## Renamed in this change

- 232 Client-face specs, from `*.spec.{ts,tsx}` to `*.client.spec.{ts,tsx}`.
- 5 Client-face helpers, from `*.{ts,tsx}` to `*.client.{ts,tsx}`: `connection/tests/fake-api`, `runtime/tests/fake-api`, `runtime/tests/event-script`, `ui-conversation/tests/chat-snapshot-fixture`, `ui-tool/tests/tool-details-render`.
- 4 Host-face specs in `packages/client/connection/tests/`, from `*.spec.ts` to `*.host.spec.ts`: `api-request-trust`, `http-bridge`, `node-half`, `websocket-downlink`.
- 2 snapshot files, following their spec's name with unchanged content.

`scripts/rescope-vendor.ts` names three of these specs in its exact-edit table, so those paths moved with them.

## Alternatives considered

**Suffix only the Host-face files as `*.host.spec.ts` and leave the Client side alone.** The first attempt, and it cannot work: `.host.spec.ts` also ends in `.spec.ts`, so the host aggregate's exclusion of `*.spec.ts` swallows it, and `include` cannot win it back. Naming both faces is what makes the two patterns disjoint.

**Name the Host-face files `*.host-spec.ts`, outside the `.spec.ts` convention.** Disjoint from `*.spec.ts` without touching the Client side, but it leaves the repository's test-naming convention and the vitest discovery pattern for a config detail.

**Move the Host-face specs to a `tests/host/` subdirectory and partition by path.** Also works with globs, but it splits one package's tests across two directories, and a reader browsing `tests/` no longer sees them together.

**Keep the exclusion of `packages/client/**` and carve the Host-face specs back with `files`.** `files` is not filtered by `exclude`, so it does reach them — one file asserting a directory belongs to the other aggregate while listing exceptions to that assertion, with a new entry required per Host-face spec.

## Consequences

The rule costs a suffix on every client test filename and buys a mechanical partition: an aggregate's membership follows from a filename, not from a list. The `constraints` rule against cross-face references keeps its full strength — no package is exempt.

The Host program now sees 11 files under `packages/client` (the four Host-face specs and the carrier's Host-face declarations, resolved through its project reference) instead of the 60 that leaked in while the exclusion was pattern-based but the filenames were not.

vitest discovers every renamed file through `**/*.spec.{ts,tsx}`, so no test configuration changed; the full client suite runs 235 files and 3181 tests.

An unsuffixed new test is the failure mode this leaves open: it type-checks in the Host program against Client source instead of failing loudly.
