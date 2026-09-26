# Agent Note: Preserve installed Desktop update evidence across restarts

Status: implemented

English | [中文](2026-09-14-desktop-installed-update-journal.zh.md)

## Problem

An installed update replaces application files and exits the process that observed the download. Terminal output alone cannot connect a failed transfer, explicit retry, installation authorization, and the next version's startup. Raw updater diagnostics can contain private URLs or credentials.

## Decision

The Desktop main entry accepts an opt-in absolute `DSH_DESKTOP_UPDATE_JOURNAL_DIR`. Qualification packages must retain the same external directory across versions. Each process exclusively creates a separate JSONL file and flushes whitelisted state and action records before continuing. The installed version, PID, sequence, and UTC time identify records. Integer progress changes limit repeated writes; raw errors, URLs, request headers, and chat content are omitted. Known error tokens produce fixed classifications instead of copied diagnostics.

Without the variable, the journal is disabled. Explicit qualification storage failures propagate rather than silently claiming complete evidence. Startup and workspace readiness are observations, not proof of installer success or preserved user data. The [local qualification decision](2026-09-10-desktop-local-updater-qualification.md) remains active: this journal does not supersede its isolation, intercepted-installation limits, or hardware restrictions.

The [installed-run tool](../../../../apps/desktop/scripts/installed-update-qualification.ts) allocates a private test manifest without credentials or remote operations. Its read-only inspector requires an ordered failure, manual retry, readiness, confirmation, and quit in one original process, followed by successor startup and workspace readiness. Unknown fields, partial records, sequence gaps, and mixed process identities are rejected. Even complete recorded flow retains independent operator checks for publication timing, network recovery, installer completion, and preserved data; a collection of startup logs cannot substitute for those observations.

## Alternatives considered

**Keep only terminal output or installation-directory files.** Installation replaces application files, and the new process can outlive the terminal. The evidence directory remains outside the installation tree.

**Persist arbitrary logs and redact known secrets.** Unknown authentication values and private paths cannot be exhaustively enumerated. Field whitelisting retains less detail but excludes those strings.

## Consequences

Journal collection snapshots validated bytes once and derives both retained files and milestone reports from those bytes. Re-reading a changing source separately for each output could report observations absent from the saved logs. Each collection uses a new directory and hashes its files; earlier collections and source journals remain unchanged. Fixed diagnostic values are checked at the file reader, not only at the writer, before bytes can enter a collection. Invalid input refuses collection; storage failure preserves partial evidence rather than claiming completion. A complete milestone sequence still leaves operator acceptance pending.

Journal and main-entry tests cover persistence, retry milestones, separate version files, omitted private fields, and unavailable storage. Installed restart, installation completion, data preservation, and network fault injection still require operator qualification. Logs have no automatic deletion; the operator owns retention and must reject missing or incomplete evidence. The journal never clears signing locks or authorizes installation.
