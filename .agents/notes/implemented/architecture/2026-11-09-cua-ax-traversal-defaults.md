# Agent Note: AX traversal defaults and per-read limits

Status: implemented

English | [中文](2026-11-09-cua-ax-traversal-defaults.zh.md)

## Problem

A shallow read can omit a control in a deeply nested window. Increasing the profile settings to reach it also increases the work and possible output of subsequent reads.

## Decision

For an accessibility tree read, the Host takes each of `maxElements` and `maxDepth` from the request when present and from the provider configuration otherwise. A caller can raise or lower either value for one read. The native provider enforces its traversal ceilings. On macOS, Paste menu discovery always uses the configured values because the paste operation has no traversal options.

## Alternatives considered

**Cap each read at the configured values.** With a profile tuned for small reads, recovering a truncated branch would require changing the profile even when the provider can handle a larger request. Per-read overrides let the caller inspect that window and return to the usual limits on the next read.

## Consequences

Lowering a profile default reduces the budget for ordinary reads. An explicit larger request can take longer and produce more text. The native operation deadline and response size limit still apply. The [macOS configuration table](../../../../packages/experimental/cua-macos/README.md#use-this-package) lists the defaults.
