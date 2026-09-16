# Agent Note: Linear Session list cache reconciliation

Status: implemented

English | [中文](2026-09-15-linear-session-list-cache.zh.md)

## Problem

The Client Session list retains row objects for React reference stability. Scanning the entire new list for every cached ID makes snapshot rebuilds quadratic, including first hydration because new rows enter the cache before cleanup. Thousands of Sessions can occupy the browser thread during list updates.

## Decision

SessionManager builds one ID set from its reconciled rows and uses it for cache eviction and selected-row membership. Field comparisons, row identities, array reuse, lineage order, and retained subagent addresses keep their existing semantics.

## Alternatives considered

**Replace the row cache on every rebuild.** A new Map can also remove missing entries linearly, but requires changing the row-reuse path. A temporary membership set confines the change to membership checks.

**Enforce unit-test wall-clock limits.** Shared CI load makes tight time budgets unreliable. An instance-local ID accessor counts membership reads during repeated refreshes; the original implementation exceeds the linear bound without depending on machine speed.

## Consequences

Reconciliation uses O(n + c) time and O(n) temporary membership storage for n current rows and c cached rows. Missing rows lose cached identity; unchanged rows and their array retain identity, and an off-list selection candidate can become current again when its row returns.

Local macOS arm64 Node 26 measurements compile the production manager to JavaScript and time subscribed refreshes through the resulting list snapshot, with fresh synthetic Remote response objects. After three warmups, nine samples give median refresh times of 0.67, 1.40, 2.78, and 5.46 ms for 1,000, 2,600, 5,000, and 10,000 rows. The corresponding original medians are 4.86, 29.01, 30.62, and 459.89 ms. These measurements include list reconstruction and exclude server scanning, transport, DOM rendering, browser input, and memory measurement; they do not establish end-to-end reconnect latency. The focused manager tests cover eviction, empty lists, selection recovery, identity reuse, and the linear read bound.
