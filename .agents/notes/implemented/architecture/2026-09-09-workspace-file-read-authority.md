# Agent Note: Workspace file read authority

Status: implemented

English | [中文](2026-09-09-workspace-file-read-authority.zh.md)

## Problem

Workspace Files serves both file content and workspace navigation. Applying workspace containment to every operation creates a second read policy above the Session filesystem backend and prevents a user from previewing paths that the same Session can read outside its workspace. HTML preview also needs direct relative JavaScript and stylesheet files, including `..` paths, while its script-enabled document can use the browser network.

## Decision

`read`, `readBytes`, `readAll`, `readRelated`, and `stat` inherit the addressed Session filesystem backend's read authority. The workspace root is the base for relative input paths, not a read boundary; absolute paths and relative paths that leave the workspace are readable when the backend allows them. The service still requires regular files, refuses symlinks, and applies its text and byte caps.

`list` and `changes` remain workspace-scoped because they expose workspace navigation and observation rather than a named file read. `list` rejects a directory outside the root, and `changes` filters observations through the backend's workspace-containment predicate.

`readRelated` resolves a relative path from the base file's directory. A `..` path may therefore read JavaScript or CSS outside the workspace when the Session backend permits it. Document Preview packages bounded, statically declared local scripts and stylesheets into an HTML Blob iframe with `sandbox="allow-scripts"`; the opaque origin blocks parent access, but the browser retains normal network access. This exposure is an intentional security trade-off for rendering static generated HTML.

The [Workspace Files service](2026-09-05-workspace-files-service.md) owns paging, file checks, listing, and observation. [Document Preview](2026-09-08-document-preview-operations.md) owns which related files are packaged and the iframe sandbox.

## Alternatives considered

**Contain every operation within the workspace.** This gives previews a narrower policy than the Session filesystem backend, blocks explicitly addressed readable files, and prevents HTML beside external assets from rendering. Workspace containment remains where the operation itself represents the workspace.

**Permit outside reads but block all iframe networking.** A stricter CSP would reduce exfiltration risk, but it would also reject external assets and network behavior intentionally retained for the static-HTML preview. The opaque sandbox protects the parent application; it does not promise network isolation.

## Consequences

Any caller holding a valid Session file address can receive bytes from every regular file that the Session filesystem backend permits it to read, including files outside the workspace. A previewed HTML document can execute packaged local JavaScript and make network requests. Outside files do not produce `changes` frames, so their previews require explicit refresh to observe updates.
