# Agent Note: Publint test subprocesses inherit the execution lane deadline

Status: implemented

English | [中文](2026-09-07-publint-test-subprocess-lifetime.zh.md)

## Problem

The publint script tests have a five-second synchronous subprocess deadline below the Windows coverage lane's existing 90-second test and hook budgets. Captured Windows failures report null status in both the valid and invalid JavaScript/CSS cases; the valid case takes 5028 ms. Those logs omit the subprocess error and signal, so they do not establish ETIMEDOUT. The deadline mismatch is a shared test defect, not evidence that a product change caused the failures.

## Decision

The [publint spec](../../../../scripts/publint-all.spec.ts) uses the existing Execa dependency with Vitest's test-context signal. There is no independent subprocess timeout. The [workflow](../../../../.github/workflows/ci.yml) and [coverage argument owner](../../../../scripts/coverage-partitions.ts) remain responsible for budgets. This applies the same lane-ownership rule as the [subagent teardown tests](2026-09-07-subagent-teardown-test-budgets.md) without changing their cleanup.

Each direct Node child is registered immediately, cancellation requests SIGKILL, and teardown awaits every owned child's result and close event before removing private package roots. Process errors, cancellation, timeout flags, signals, and captured streams are diagnosed before expected exit codes. An ordinary exit code of one remains valid for negative publint cases. All five cases invoke the real script with isolated publication fixtures.

## Alternatives considered

- Increase the five-second constant: another local constant would still override the execution lane's budget.
- Preload or replace publint: neither exercises cold script imports and the real publication checks.
- Return after kill: process and pipe closure must precede fixture removal.

## Consequences

A readiness-gated deadline regression cancels two live children and checks both closure events, dead PIDs, and informative diagnostics. A missing working directory verifies spawn-error diagnostics. Independent concurrent spec processes exercise temporary-directory isolation and subprocess scheduling. Native Windows CI remains the owner of Windows termination and filesystem evidence; macOS results do not establish those guarantees. Product code, workflow budgets, and snapshot output remain unchanged.
