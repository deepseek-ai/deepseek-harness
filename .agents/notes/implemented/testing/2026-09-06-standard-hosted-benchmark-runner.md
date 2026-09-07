# Agent Note: Standard hosted runner for required benchmarks

Status: implemented

English | [中文](2026-09-06-standard-hosted-benchmark-runner.zh.md)

## Problem

Wall-clock performance checks need an isolated execution lane and a consistent runner class. Routing them through the enterprise Linux failover switch makes their measurements depend on either larger hosted capacity or a shared self-hosted VM, while also consuming capacity needed by parallel correctness checks.

## Decision

The required benchmark job in [ci.yml](../../../../.github/workflows/ci.yml) uses the standard GitHub-hosted `ubuntu-24.04` runner independently of Linux failover. It always attempts to restore the pnpm store cache and retains a standalone benchmark lane. The complete job has a 15-minute timeout covering setup, installation, builds, and measurements. This bounds infrastructure execution, not an individual performance assertion.

The [Session performance decision](2026-09-04-session-open-performance-gate.md) continues to own workloads, timing and memory budgets, worker isolation, and calibration. Only current-generation `open` uses an endpoint-specific 50 ms standard-runner expectation with the existing 1.25× headroom, giving a 63 ms limit. All other performance budgets and the worker, test, and hook deadlines remain unchanged. Successful raw measurements remain in the Actions log through step-local `DSH_GATE_VERBOSE=1`. The hardware-comparison workflows retain their deliberately different runner sizes.

## Alternatives considered

- Enterprise or shared self-hosted routing retains more build capacity but ties the measurement environment to unrelated failover operations.
- Increasing performance thresholds without endpoint measurements conflates a bounded CI execution with a regression allowance. Threshold changes require measured calibration and positive and negative controls.

## Consequences

A standard runner trades parallel build capacity for a fixed measurement class without removing the required verdict. Cache misses and runner variation can still affect total duration. Each runner change needs an actual hosted benchmark run before its job timeout is treated as validated; local workflow assertions alone cannot establish execution time.

The owning [workflow tests](../../../../scripts/ci-workflow.spec.ts) pin runner routing, unconditional cache restoration, required status, and the job timeout. Negative controls reject failover routing, a cache condition, and the former 30-minute job bound.
