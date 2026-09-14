# Agent Note: Workspace files as one dual-face API package

Status: implemented

English | [中文](2026-09-07-workspace-files-dual-face-package.zh.md)

## Problem

The workspace file service and its browser resource provider evolve together, but their compiler graph contained reverse dependencies on Remote assembly and Sidebar UI. Splitting the packages avoided the cycles while separating ownership of the wire protocol from its Client model. A Host-only package with a types-only Client compiler entry also lacks the `dsh.client` and `./client` declarations that distinguish runtime exports in Client catalog analysis.

## Decision

`packages/api/workspace-files` owns both implementations. Its Host and Client leaf configurations remain direct references of their respective root aggregates; the solution root references both leaves. The Host exports the file service, `./client` exports the actual resource-provider plugin, and `dsh.client` declares the browser plugin. One web-app row loads both faces. This supersedes only the package-splitting decision in the [workspace file service note](2026-09-05-workspace-files-service.md), whose authorization, paging, and stream semantics remain unchanged.

Two dependency directions keep the compiler graph acyclic:

- `client/resources` imports `RemoteResult` and `RemoteFailure` from their defining `typert/protocol` package, not from `api/remotes`, which assembles providers that consume the resource model.
- The text preview declares `SidebarRightResourceParamsMap.file` using the file package's exported parameter type. The file provider declares its resource value but imports no Sidebar UI. The caller imports the viewer's type entry when it needs that navigation declaration.

These remove `remotes → workspace-files → resources → remotes` and `remotes → workspace-files → sidebar-right → ui-conversation → remotes`. Runtime Cordis service injection remains independent from TypeScript project references.

## Alternatives considered

**Keep separate packages.** This isolates the compiler cycle but splits one file capability's Host and Client ownership. Removing the reverse type dependencies permits the same dual-face organization as other API controllers.

**Remove the root Client reference.** Transitive references still compile the leaf, but both root aggregates must explicitly name this package's matching face.

**Change catalog analysis or add an empty Client plugin.** Neither supplies the requested browser implementation. A real `./client` export with `dsh.client` uses the analyzer's existing supported dual-face path.

## Consequences

Host wire methods and browser resource behavior are unchanged. The browser implementation, tests, and documentation have one package owner; Client type dependencies stop at the protocol and resource-model layers instead of reaching UI or Remote assembly.

## Verification

The Cordis inspect catalog check analyzes the declared Client export, both compiler aggregates retain their leaf references, and the Host and Client file-service tests exercise the same implementations. The existing dependency and project-reference checks enforce their compilation relationships.
