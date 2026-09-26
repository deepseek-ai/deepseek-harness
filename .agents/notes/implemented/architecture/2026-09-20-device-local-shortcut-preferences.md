# Agent Note: Keep shortcut preferences device-local and commit before activation

Status: implemented

English | [中文](2026-09-20-device-local-shortcut-preferences.zh.md)

## Problem

Keyboard bindings depend on the receiving device's operating system and browser restrictions. A Host can serve several devices, while a local save can fail after a user records a new combination. Activating an unpersisted binding makes the interface disagree with the next application launch. Rewriting unreadable or future-version preferences can destroy choices an older client cannot interpret.

## Decision

[The shortcut service](../../../../packages/client/shortcuts/README.md) stores only versioned overrides per runtime/platform. Web owns origin-local browser storage; Electron main owns `userData/keybindings.json`, independently of Harness home. Both adapters share validation and transaction logic. Successful persistence publishes one accepted configuration from which command matching, keycaps, and native interception derive.

Missing commands retain dormant overrides. Explicit overrides win over newly introduced defaults; conflicting explicit overrides are all disabled. Unreadable configuration blocks ordinary edits and preserves the last accepted values. Restore All clears only the accepted current profile and cannot overwrite unreadable or future-version data.

## Alternatives considered

**Host settings.** A server's operating system and settings scope do not identify the visitor's device or browser restrictions. Host storage would also couple remote visitors' preferences.

**Optimistic activation.** Updating bindings before persistence makes a failed save appear successful and leaves restart behavior inconsistent with the visible controls.

**Cross-tab atomic merging.** localStorage has no compare-and-swap transaction. Web rereads before each operation and rejects known stale drafts, but accepts last-writer-wins for simultaneous writes. Electron main serializes edits and rejects stale revisions.

## Consequences

Devices and Web/Desktop do not synchronize bindings automatically. Repairing unreadable preferences requires correcting the stored document; application edits preserve those bytes. Browser concurrency does not promise lossless merging. Atomic Desktop replacement uses the shared writer's Windows retry behavior without promising fsync durability. Deterministic transaction, browser-storage, and Desktop-file tests cover failure retention, conflicts, stale drafts, and refusal to replace unreadable data; platform keyboard acceptance remains separate from persistence correctness.
