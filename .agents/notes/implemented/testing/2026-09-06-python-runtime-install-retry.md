# Agent Note: Bounded retry for Python runtime dependency install

Status: implemented

English | [中文](2026-09-06-python-runtime-install-retry.zh.md)

## Problem

The Python runtime lane's `Install (immutable)` step runs `pnpm install` on every target, and install-time native build downloads fetch Node headers from nodejs.org. That endpoint stalls intermittently: on 2026-09-06 the hosted `node24-macos-x64` cell failed when the `fs-ext` build's node-gyp download raised `ConnectTimeoutError` against nodejs.org after a 10-second connect timeout, aborting the immutable install. The stall is external and transient; the lane previously had no recovery beyond a human job rerun.

## Decision

The install step retries `pnpm install --frozen-lockfile` up to three attempts total with a ten-second pause between failures, running under `bash` on every platform (Git Bash is on the hosted Windows images). Success on any attempt ends the step immediately; a file-lock check or native-build error that would fail every attempt still fails the step after the bounded budget. This mirrors the Wine lane's documented bounded-transfer policy without pulling in a mirror, because these installs also resolve native addons whose second-download provenance matters.

## Alternatives considered

**Increase the connect or job timeout.** Rejected: the observed stall is a connect timeout after 10 seconds, and retrying the whole operation with a fresh connection is the recovery the failure mode calls for; a longer timeout still fails when the endpoint is down.

**Use a mirror for Node header downloads.** Deferred: the Wine lane's mirror resumes its own archive; the Python runtime lane would need a per-target mirror and its own checksum authority, which the retry does not require for a transient outage.

**Rerun failed jobs by hand.** Rejected as the lane's standing remediation: it costs a full lane cycle and stays manual; the bounded retry absorbs the transient while a sustained outage still fails loudly.

## Consequences

A transient nodejs.org stall costs at most two extra install attempts (about twenty seconds), while a deterministic install defect still fails after the budget. All targets share the same retry path, and install diagnostics remain the pnpm output captured inside the step.
