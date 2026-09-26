# Agent Note: Account-scoped Platform browser storage

Status: implemented

English | [中文](2026-09-22-platform-browser-storage.zh.md)

## Problem

Embedded Platform notices store dismissal in localStorage. Disposable browser partitions lose that preference whenever the view closes.

## Decision

Desktop partitions browser storage by a SHA-256 hash of the Platform origin and stable account ID. Persistent partitions retain localStorage page preferences across view and application lifetimes, including sign-out and later sign-in to the same account. Raw account IDs and tokens do not appear in partition names. While the Host has no account ID from a successful profile read, the view uses a disposable partition, so preparing a Platform session never waits for a profile request. An ID that arrives for the credential already open leaves the mounted disposable document in place; the next open uses the account-scoped partition.

A persistent partition keeps only localStorage; opening one clears cookies, filesystem, IndexedDB, Cache Storage, the HTTP and shader caches, service workers, and HTTP authentication before the document loads, while a disposable partition clears all of its storage. Closing a view destroys its document, detaches the credential-bearing request interceptors, and schedules the same cleanup, so authentication left by an unclean exit is cleared before the next document loads. The next open and application shutdown await that cleanup, and an update install awaits it before the installer takes over the exit; shutdown reports a failure instead of blocking the quit. A failed cleanup rejects that open and keeps its account from opening again until a later cleanup succeeds, while other accounts keep opening. Host-only credentials still enter the trusted page through the existing preload and are not written to browser storage by the bridge.

## Alternatives considered

One shared partition mixes account preferences. Token-derived names discard preferences when credentials change. A notice-specific native API would duplicate Platform preference ownership and require coordinated frontend changes. Clearing storage only when a view closes leaves authentication from an unclean exit readable by the next document.

## Consequences

Preferences remain local to this Desktop browser-data directory and are not synchronized across devices. Platform scripts remain trusted to handle the credential they receive; persistent site storage is not a credential vault. Storage for a signed-out account stays on disk until that account signs in again or the browser-data directory is removed. The real Electron regression checks notice dismissal across view recreation, account switches, and process restart, and that cookies, Cache Storage, and IndexedDB are cleared, a page beforeunload handler does not hold the close, a disposable session neither inherits nor retains preferences, and cookie residue from a previous process is cleared.
