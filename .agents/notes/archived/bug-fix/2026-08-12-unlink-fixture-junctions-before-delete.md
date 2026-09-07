# Agent Note: Unlink fixture junctions before recursive deletion

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-12-unlink-fixture-junctions-before-delete.zh.md)

## Problem

The install-lefthook and translation-pairing fixtures junction the repository's real `scripts/`, `node_modules`, and tsx package directories into fixture trees so installer probes resolve through them. Windows recursive deletion can treat a junction (a MOUNT_POINT reparse point) as a directory and follow it into its target; Git's `worktree remove` did exactly that and deleted the repository's tracked `scripts/` and tsx package (the incident's instrumentation pinned the deletion to that step). A fixture cleanup that trusts its deleter therefore deletes the repository's own sources instead of the fixture.

## Decision

`scripts/test-fixture-cleanup.ts` owns junction-safe fixture teardown: `unlinkFixtureLinks` walks a tree and unlinks every reparse point before `removeFixtureSafely` removes the now link-free tree (with Windows async-handle retries). Every affected `afterEach` and the pre-`worktree remove` hook call it. The general rule lives in `docs/defensive-patterns.md`: remove link-shaped paths with unlink, reserve recursive `rmSync` for known real directories.

## Alternatives considered

**Trust recursive deletion alone.** Rejected: whether a given deleter follows junctions is tool- and version-dependent, and one path through `git worktree remove` already destroyed tracked files; no cleanup may bet the repository on that behavior.

**Copy instead of junctioning the real directories.** Rejected: the fixtures exist to probe the real installer paths through their real contents, so copies would stop exercising the boundary under test.

## Consequences

Fixture teardown can no longer reach repository sources through junctions. The extra walk is one lstat/unlink pass over small fixture trees. The data-destroying defect now has its durable why beside the defensive-patterns rule, and the helper is the shared teardown path for future junction fixtures.
