# Agent Note: Schedule rule storage and shared recurrence

Status: implemented

English | [中文](2026-10-21-schedule-rule-storage.zh.md)

## Problem

Host tasks already use the versioned `schedule` domain. A second domain, importer, and placeholder RRULE duplicate timing and storage authority. Cron and RRULE should be supported timing types rather than separate generations of the task API.

## Decision

Use `schedule` version 2 with `compatibleVersions: [1]`, retaining its backend routing, envelope, and whole-unit layout. Extend the existing accepted-version policy to authoritative JSON and SQLite units; reads leave storage unchanged, and the next write commits the current stamp with its data. Add `rrule` to the six existing record kinds and evaluate every kind normally. Remove the standalone store importer, import marker, placeholder RRULE, and parallel Session-bound management API. Move reusable Cron and RRULE parsing and bounded occurrence arithmetic into `dsh-util-time`; Schedule owns records, targets, delivery admission, history, and errors.

An explicit target wins. Without one, read an existing `sessionId` as a Session target; otherwise reserve a stable `new_once` target. Optional new metadata receives read defaults without rewriting storage. Every successful edit writes the current row format without `sessionId`. Custom timing accepts either RRULE or a five-field Cron expression with an explicit zone; UI labels name neither syntax. Model guidance continues to teach RRULE.

This partially supersedes [standalone schedules](2026-09-17-standalone-schedules.md): its target, execution, notification, and Host-wide management decisions remain. It restores the domain and layout in [Host schedule storage](2026-09-16-host-schedule-storage.md), while replacing that note's Session-bound management API. Both notes remain active and link to this decision.

## Alternatives considered

Changing the domain or layout would require routing and copy logic without changing the feature. Converting Cron into RRULE can change day-of-month/day-of-week and time-zone semantics. A generic value migration engine is deferred until an incompatible storage version requires one; the existing domain envelope already identifies the version.

## Consequences

Missing creation metadata cannot recover historical timestamps. A default target must retain its reserved Session identity across reads and retries. Old receipts need their original destination retained before retargeting. A current unit stamp can contain older untouched rows, so future compatible readers must retain those defaults until a complete rewrite allows removal. Old binaries reject a newer stamp. Session inbox persistence and task acknowledgment remain separate commits, so delivery remains at least once.
