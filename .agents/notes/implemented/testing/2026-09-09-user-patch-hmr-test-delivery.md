# Agent Note: User-patch tests control filesystem event delivery

Status: implemented

English | [中文](2026-09-09-user-patch-hmr-test-delivery.zh.md)

## Problem

The macOS Sandbox run (run 34238200206, job 102101292119) times out while waiting for the first user-patch addition. Concurrent local reproductions show no filesystem notification reaching HMR. A polling variant also misses a subsequent edit while HMR has no pending refresh. These failures prevent the refresh assertions from exercising the parser, activation, and recovery behavior they own.

## Decision

The [user-patch test](../../../../packages/boot/app-boot/tests/user-patches.spec.ts) writes real patch files and delivers their add, change, and unlink events through a Chokidar watcher without native watch handles. App-boot watcher registration, refresh serialization, Include recomposition, plugin activation, failure reporting, and recovery remain real; plugin rollback is absent under the [Loader policy](../simplification/2026-09-09-nontransactional-loader.md). The fixture restores its watcher factory and disposes the Context even when setup fails before the local cleanup block.

The separate [watcher tests](../../../../packages/boot/hmr/tests/watch-config.spec.ts) own native notification delivery, including add/change/unlink, initially absent parents, and filesystem aliases. The refresh test does not establish operating-system delivery guarantees.

## Alternatives considered

**Native notifications for every refresh assertion.** Rejected because it repeats the native delivery dependency across each parser and activation state transition. A missing event obscures which downstream behavior is broken.

**Polling and fixed settling delays.** Rejected because neither acknowledges delivery of the next edit. Chokidar readiness does not expose completion of Node's asynchronous initial polling baseline; a local polling reproduction still misses changes. Increasing the test deadline cannot recover an event that was never emitted.

**Mock HMR registration or Include.** Rejected because the test must retain real recomposition, report activation failures, and preserve the running configuration after parse failures.

## Consequences

The refresh sequence retains its semantic assertions and removes fixed change-throttle sleeps. Independent concurrent processes exercise isolation, and a forced setup failure verifies watcher closure and factory restoration before the next case. Native watcher failures remain visible in their owning tests and require their own diagnosis.
