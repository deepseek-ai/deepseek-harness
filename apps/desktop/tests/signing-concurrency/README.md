---
description: "Windows signing concurrency measurements and retesting on replacement runners."
---

# Windows signing concurrency qualification

English | [中文](README.zh.md)

## Summary

Use this record when choosing signing concurrency on a replacement Windows runner. Results apply to the measured host, token and software combination; repeat qualification after changing them. Production signing remains serial.

## Table of Contents

- [Retest on another machine](#retest-on-another-machine)
- [Measured reference](#measured-reference)

<a id="retest-on-another-machine"></a>

## Retest on another machine

1. Follow the [operator-approved experiment procedure](../../windows-signing/README.md#verification), using a hash-pinned corpus of real runtime, application and installer files. Compare the same inputs across modes; preserve originals and use isolated copies without signature-cache reuse.
2. Run `--corpus` with `--rounds 2` to compare 1/1, 2/2 and 4/4 completion workers/hardware requests, reversing the second round. Run the same corpus with `--pipeline-control --rounds 2` for the 4/1 control. Retain the procedure's first-failure stop and interlock handling.
3. Record the date, test and artifact versions, corpus count/bytes/largest file, CPU/RAM/disk, token/client/provider/SignTool versions, timestamp service, competing jobs and resource pressure. Keep both batch wall times and failure/retry counts; retain detailed output outside Git without credentials. Select a candidate only from completely verified runs, then validate it in the complete signed release workflow. Similar results favor fewer hardware requests; unexpected variation needs more rounds.

<a id="measured-reference"></a>

## Measured reference

On 2026-10-22, the experiment in PR #6675 used retained files from release run 39725804188, version `0.2.1-rc.2.20261022.50.2`. Each batch contained 148 runtime and 8 application/installer targets: 156 files, 849.2 MiB unsigned, largest 277.5 MiB. Deleted transient targets and repeated intermediate signing passes were excluded.

The host had a Ryzen AI 9 HX 470 (12 cores/24 threads), 32 GiB RAM and a 1 TB UMIS RPJYJ1T24RLS1QWY disk. The operator identified the token as SafeNet 5110; the precise variant/firmware was not verified. Signing used SafeNet Authentication Client 10.9.4482.0, `eToken Base Cryptographic Provider` and the unchanged machine test preset's SignTool/timestamp service. Public signature removal alone used SDK 10.0.26100.0 SignTool. Mode-average host CPU was 7.6–8.9%, minimum sampled free RAM was 9.9 GiB, and no Runner.Worker was sampled; other Node processes shared the host.

Times below are batch wall seconds, including signing, timestamp completion and all file verification. They exclude preparation, lock waiting, build, cache lookup, package assembly and upload. File-system caches were uncontrolled; these are not cold/hot full-release measurements.

| Completion workers / hardware requests | Round 1 (s) | Round 2 (s) | Mean (s) | Reduction vs serial |
|---|---:|---:|---:|---:|
| 1 / 1 | 732.3 | 718.5 | 725.4 | — |
| 2 / 2 | 398.3 | 394.6 | 396.5 | 45.3% |
| 4 / 4 | 459.4 | 465.0 | 462.2 | 36.3% |
| 4 / 1, separate control | 427.7 | 428.3 | 428.0 | 41.0% |

All 1,248 signatures, timestamps and final validations passed, with zero hardware failures/timeouts or timestamp retries. Original files and signature-cache payloads remained unchanged. The 2/2 mode was fastest; 4/4 was slower, while pipeline overlap alone delivered most of the observed benefit. This selects candidates for further release testing, not a production default or evidence of parallel operations inside the token. It does not establish a ten-minute complete release.

## Dev Note

None.
