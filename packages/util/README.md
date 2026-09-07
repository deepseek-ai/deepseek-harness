---
description: "Package map for shared utilities: atomic file writes, branded ids, deques, JSON values, harness home paths, launch environment, native commands, output retention, time zones, and timeouts."
kind: "package-group"
---

# util/ — shared utilities

English | [中文](README.zh.md)

## Summary

The `util/` group gives capability packages shared mechanical primitives instead of duplicate implementations. It covers atomic writes, branded ids, deques, lossless JSON values, UUIDs, Harness-home paths, launch environments, outbound proxy policy, native commands, output retention, time-zone canonicalization, and timeout handling. Every root entry here is a library: it registers no product service or event, and the consuming capability retains the business semantics.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package provides one primitive; open a package page for how to use it.

| Package | Role |
|---|---|
| [`brand/`](brand/README.md) | Nominal string types and their stateless constructor |
| [`package-manifest/`](package-manifest/README.md) | Shared TypeScript declarations for package manifests |
| [`crypto/`](crypto/README.md) | Mints RFC 9562 v4 UUIDs from the cross-runtime `crypto.getRandomValues` primitive |
| [`deque/`](deque/README.md) | Provides amortized constant-time queue operations with bounded vacant storage |
| [`values/`](values/README.md) | Validates, snapshots, compares, and freezes lossless JSON-compatible values |
| [`home-paths/`](home-paths/README.md) | Resolves the single Harness home and joins shared user-data paths |
| [`http-proxy/`](http-proxy/README.md) | Resolves one outbound proxy policy and installs it for `fetch`, SDK agents, and spawned children |
| [`launch-environment/`](launch-environment/README.md) | Frozen launch environment that remembers which layer supplied each value |
| [`atomic-write/`](atomic-write/README.md) | Atomic file replacement and cross-process writer locking |
| [`native-command/`](native-command/README.md) | Runs host-native commands directly, never through a shell string |
| [`workspace-path/`](workspace-path/README.md) | Provides browser-safe Workspace path and display helpers |
| [`output-retention/`](output-retention/README.md) | Bounds model-facing output and reports exact omission metadata |
| [`time/`](time/README.md) | Validates and canonicalizes a caller-reported IANA time zone |
| [`timeout/`](timeout/README.md) | Deadline arithmetic, signal fusion, and timeout-versus-cancel classification |

-----

<a id="related-documentation"></a>
## Related documentation

- [Root package map](../README.md) — where `util/` sits among all package groups.
- [Generated configuration catalog](../../docs/config-catalog.md) — the library-package index this group forms part of.
- [Adding a package cookbook](../../docs/cookbook/adding-a-package.md) — how a new shared primitive lands in this group.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
