# Agent Note: Resume headers do not repeat system prompts

Status: implemented

English | [中文](2026-09-03-resume-headers-do-not-repeat-system-prompts.zh.md)

## Problem

Forking a Session copies the source history into the child. The child's first model request then records a `request/header` with reason `resume`, even when its system field is identical to the preceding copied header. Chat treated every resume header as a new display point, so continuing the fork showed a second `System prompt` row and suggested that the system prompt had been injected twice. The provider request still carried the system field once; the duplicate existed only in Chat presentation.

## Decision

The durable resume header records the request boundary needed for exact Session reconstruction. Chat compares that full header with the preceding loaded Request Prompt and displays a non-empty system prompt only for the initial request, an explicit message-series start, or a real system-field change. An unchanged resume does not create a visible repetition.

A partial history window may begin with a non-initial header and lack the predecessor needed for comparison. Chat renders that system prompt conservatively. If prepend later supplies an identical predecessor, the existing request-prompt Node becomes hidden instead of being withdrawn; its key and page-lifetime anchor stay stable. A different system field remains visible.

Trajectory exposes every request header and its classified changes. Chat presentation does not alter provider requests, Session events, or reconstruction.

## Alternatives considered

**Omit unchanged resume headers from the Session log.** Rejected: resume is a real request boundary, and removing it would make exact reconstruction depend on process history that the durable log does not contain.

**Special-case only forked Sessions.** Rejected: an ordinary process resume has the same presentation semantics, and the request headers already contain the system fields needed for a direct comparison.

**Keep the duplicate row as a lifecycle marker.** Rejected: `System prompt` describes model-visible request content, so using it to mark a loop restart incorrectly implies another prompt injection. Request lifecycle evidence remains available in Trajectory.

## Consequences

Continuing a fork or resuming a process with an unchanged system field leaves one visible `System prompt` row for the current message series. Explicit series starts and real system changes still repeat the row. A partial window can initially show a conservative row and hide it after older history loads, while retaining the same materialized Node.

The unit regression covers initial, series, unchanged resume, system-change, and prepend cases. The Web recorded-session scenario contains an unchanged resume header and asserts that the settled Chat renders exactly one `System prompt` control.
