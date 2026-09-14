# Agent Note: Hosted-image assumptions in the coverage suite

Status: implemented

English | [中文](2026-09-10-hosted-image-test-assumptions.zh.md)

## Problem

The [failover leg](../process/2026-09-09-blacksmith-failover-leg.md) runs this suite on pools this repository does not own — Blacksmith's ephemeral images, and the in-house `vm-backup` and `dsh-win-ci` standbys. On the hosted image the coverage lanes failed on host properties their cases never named: whether the host offered a usable user-systemd scope decided which containment a mocked PTY exit raced; a managed scope reported a signal failure during ACP teardown; a starved reader coalesced writes the illegal-UTF-8 residual cases assumed arrived as separate chunks; and a Windows Server image refuses `CoCreateInstance(CLSID_FileOpenDialog)` outright.

## Decision

The cases declare the host properties they depend on.

Terminal tests with mocked PTY exits in `packages/subprocess/subprocess-local/tests/local.spec.ts` select fallback containment explicitly. Cases that do not exercise platform selection use `internals = { platform: 'darwin' }`. The terminal-release lifecycle case leaves the platform unset and makes `probeLinuxNative` return false to exercise the host's default platform selection without starting a real Linux scope. Both arrangements prevent a mocked exit from racing the scope bootstrap. A probe mock alongside the platform pin is redundant because the pin bypasses that probe.

`disposal contains a spawn-failure rejection that races teardown` asserts the settlement contract instead of one winner of the race: a bootstrap that published its pre-exec failure rejects with that failure, and a teardown that stopped the bootstrap first settles as the requested `SIGTERM`. Only the Linux scope records the stopped arm, because the win32 job owner turns a cancelled start into a rejection and the fallback launcher rejects the missing directory.

`plugin-config dispose graces reach the real ACP run` configures 5000ms dispose graces. Its mock refuses stdin EOF and `SIGTERM` by design, so the case waits out both graces (~10s) and carries a 30s case budget, above the 5000ms default the local unit entry grants. The scope signal failure also occurs with these graces; increasing them does not establish termination. The [direct-settlement decision](../bug-fix/2026-09-12-linux-scope-direct-kill-settlement.md) defines the process event and fresh scope evidence required after a fallback kill succeeds or independently proves direct-process absence.

Both illegal-UTF-8 residual cases in `packages/experimental/ptc-runtime-python/tests/runtime.spec.ts` pace their writes with `time.sleep(0.001)`: `os.sched_yield()` lets a loaded reader coalesce the writes into one chunk, and the coalesced chunk is what the wrapped `Buffer.concat` measures (the hosted image measured 2563 against the 2048 bound with a correct implementation). Their payloads stay above that bound — 3200 bytes for the `0xFF` case and 1100 `ED A0 80` sequences, 3300 raw bytes, for the CESU-8 case, past the 3072-byte budget a raw-byte undercount reaches — so the undercount still flushes above 2048. Each carries a 20s case budget for the paced writes plus the interpreter start.

The stray-output sealing test in `packages/experimental/ptc-runtime-python/tests/stray-fragments.spec.ts` keeps a real Python child but splits its stdout reads into single-byte events. OS pipe coalescing cannot guarantee the 1024 fragments needed to seal a block: run 34465259316 passed all assertions but missed that branch. The controlled reads exercise repeated sealing and the final newline merge; exact output and bounded copy volume detect dropped bytes and repeated prefix copies.

The Linux coverage lane grants `DSH_COVERAGE_TEST_TIMEOUT_MS: '90000'`, matching the Windows coverage lane, because the disposal cases in `subprocess-local` and `bash-sandbox` exceed the 5000ms default when the lane's partitions, workers, and sibling gates share one host.

The Windows folder-dialog smoke probes `CoCreateInstance(CLSID_FileOpenDialog)` through PowerShell instead of gating on `process.platform`. An image that answers `CLASS_E_CLASSNOTAVAILABLE` (0x80040111) runs the clean-rejection case and skips the real-dialog case, so `win32-dialog.ts` keeps its file coverage without a host that can open a dialog. Every exception from that activation reads as refusal, so a host failing the probe for another reason only loses the real-dialog case; a probe that cannot run at all keeps the win32 assumption.

## Alternatives considered

**Excluding the coverage lanes from the hosted leg.** Rejected: the leg exists to run the same suite on another pool, and the failures named real host dependencies rather than a suite the pool cannot support.

**Raising only the lane's per-test budget.** Rejected: a wider budget does not change the cases whose cost or behaviour is deterministic — a trapped ACP child still waits out both graces, and a coalesced reader still inflates the measured peak.

**Combining a platform pin with probe mocks.** Rejected as redundant: the pin selects fallback before the native probe is called. A test of the host's default platform selection instead leaves the platform unset and controls the probe result.

**Cutting the illegal-UTF-8 payloads to keep the cases fast.** Rejected: below the 2048 bound the assertion can no longer fail for the undercount it names, which leaves the regression unguarded.

## Consequences

Pinned fixtures avoid unintended containment choices: the `linux-scope` and win32-job paths keep their own dedicated cases instead of being reached through these ones. The ACP dispose case costs about 10s of wall clock per run and each residual case about 3.5s, before additional host scheduling and native cleanup costs. Hosted-image evidence: run 34449848541 failed on these cases, run 34457655892 is green with this diff plus the 90000ms lane budget, and `windows node 24 / coverage` is green on five consecutive hosted runs, where the probe reports the refusal (`clsid-probe=refused`).
