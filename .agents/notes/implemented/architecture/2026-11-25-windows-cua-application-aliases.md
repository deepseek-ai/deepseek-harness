# Agent Note: Windows application consent with explicit path aliases

Status: implemented

English | [中文](2026-11-25-windows-cua-application-aliases.zh.md)

## Problem

Windows launchers and their visible applications can use different executable paths without exposing a common AUMID. Treating every such pair as unrelated repeats approval for familiar products. Inferring a relationship for arbitrary applications also groups programs the user may intend to authorize separately.

## Decision

Windows retains the application identifier observed from the window's explicit AUMID, package process AUMID or executable path, in that order. A small maintained list maps specific launcher and runtime paths to a known product ID only when no AUMID exists, or when the caller selects an executable path. The [package reference](../../../../packages/experimental/cua-windows/README.md#known-application-aliases) owns the supported layouts. Other paths retain their existing identity. Explicit path selection preserves its launch target and does not enumerate AppsFolder.

Application association is checked when a window is first admitted. An admitted HWND retains its association while valid. The helper does not retain target PIDs or process start times, or repeat application-identity checks before each operation. Windows handle validity supplies the selected-window lifetime used by this implementation.

Authorization continues to hash `windows-aumid\0` followed by the selected ID. Explicit saved grants and revocation use [profile consent storage](2026-10-19-cua-profile-consent-storage.md). This decision is Windows-specific: [macOS bundle-ID consent](2026-10-25-cua-bundle-id-consent.md) and [shared application-consent enforcement](2026-09-26-cua-application-consent.md) retain their separate responsibilities.

Feishu's entry is supported by inspection of its installed shortcut, launcher and runtime files. GitHub Desktop declares its ID in [application code](https://github.com/desktop/desktop/blob/development/app/src/main-process/main.ts); the [Squirrel launcher](https://github.com/Squirrel/Squirrel.Windows/blob/develop/src/StubExecutable/StubExecutable.cpp) starts the same executable name from a version directory. These observations justify the individual entries, not a rule for all Squirrel applications.

## Alternatives considered

**Resolve every desktop application through private Shell interfaces.** An undocumented resolver adds system compatibility and failure dependencies to ordinary discovery. The explicit list limits inference to layouts with concrete evidence.

**Group by publisher, installation directory or process ancestry.** One publisher or directory can contain independent applications; launching another process does not imply consent for it. The list names individual executables and excludes shared update hosts and other helpers.

**Retain PID and process-start metadata and revalidate ownership repeatedly.** These checks introduce a separate application-lifetime model and additional process queries for operations on already admitted HWNDs. This implementation accepts Windows handle validity instead.

**Use only unmodified path identities.** This preserves the smallest discovery implementation but repeats authorization for the listed products' launchers and versioned runtime files.

## Consequences

The list provides product grouping, not publisher authentication. A program placed at a matching layout can share the product's grant. Versions and copies matching a listed layout deliberately share consent; unlisted launchers and runtimes may still need separate grants. Existing path grants are not automatically promoted to a shared product ID, and macOS behavior does not change.

Each list entry requires evidence for its ID and executable layout, tests that exclude nearby unrelated paths, and validation that launcher selection reaches the same application as window discovery. A generic directory rule or a new inference source requires a separate decision; expanding this list does not authorize either.
