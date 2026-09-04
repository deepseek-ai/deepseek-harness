---
description: "Browser-safe Workspace path helpers for joining relative paths, abbreviating POSIX homes, and deriving display titles."
kind: "package-library"
---

# dsh-util-workspace-path

English | [中文](README.zh.md)

## Summary

Browser-safe path helpers shared by Workspace-facing client and controller packages. The package joins Workspace-relative paths, abbreviates POSIX home directories for display, and derives Workspace titles from POSIX or Windows paths. It has no Cordis service or runtime state.

## Table of Contents

- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Resolution is lexical** — it recognizes POSIX absolute paths, Windows drive paths, and UNC paths, preserves the Workspace path's separator when joining a relative path, and does not access a filesystem or canonicalize `.` and `..` segments.
- **Home abbreviation is POSIX-only** — Windows paths remain unchanged because a portable browser cannot infer Windows home-path equivalence safely.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This utility owns no mutable runtime relationship.
