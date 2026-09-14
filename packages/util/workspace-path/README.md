---
description: "Browser-safe Workspace path helpers for joining relative paths, abbreviating POSIX homes, and deriving display titles."
kind: "package-library"
---

# dsh-util-workspace-path

English | [中文](README.zh.md)

## Summary

Browser-safe path helpers shared by Workspace-facing client and controller packages. The package joins Workspace-relative paths, abbreviates POSIX home directories for display, derives Workspace titles from POSIX or Windows paths, splits a path into its directories and final segment for display, and owns the `dsh-resource://file/…` address grammar that names a workspace file across the Sidebar and the resource model. `relativizeToCwd` removes the workspace prefix for display while preserving paths outside that directory. It has no Cordis service or runtime state.

## Table of Contents

- [File addresses](#file-addresses)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="file-addresses"></a>
## File addresses

A resource address is `dsh-resource://<type>/…`, and the type — the URI host — is the resource protocol key (`file`, or one a plugin declares in `ResourceProtocolMap`); any other scheme is a navigation protocol, defined elsewhere. `dsh-resource://file/session/<sessionId>/<path>` names the Session that authorizes the Host read and a workspace-relative or absolute path. Leading slashes remain part of the path: `/etc/hosts` is `dsh-resource://file/session/s//etc/hosts`, a Windows drive is `dsh-resource://file/session/s/C:/x/y.txt`, and UNC is `dsh-resource://file/session/s///server/share/y.txt`. The Host resolves paths and enforces access. The `absolute/<path>` form remains parseable but carries no authorizing Session, so the file provider cannot read it and Preview does not claim it; neither current nor Tab Session is borrowed. The grammar lives in [`src/file-address.ts`](src/file-address.ts); the path helpers stay in [`src/index.ts`](src/index.ts), which re-exports it.

`sessionFileAddress(sessionId, path)` normalizes `\` to `/` and drops leading `./`, but preserves leading `/` characters. Every id and path segment is component-encoded with `:` kept literal. `fileAddressFor(sessionId, cwd, path)` always builds a Session address: paths inside `cwd` become relative; other absolute paths, including when `cwd` is unknown, stay absolute within that Session address. `absoluteFileAddress(absolutePath)` builds only the Session-less form. `parseFileAddress(address)` checks the exact file-address prefix, ignores query and fragment suffixes, decodes each segment, and returns `{ scope, sessionId, path }` for a Session address or `{ scope, path }` for the Session-less form. Another type or scheme, an unknown scope, a missing id or path, or a malformed escape returns `undefined`.

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
