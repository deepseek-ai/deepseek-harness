# Agent Note: read_image accepts extension-less image paths

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-28-read-image-extensionless-paths.zh.md)

## Problem

`read_image` mapped `file_path` to a media type by extension alone and refused a path with no extension. Valid extension-less images therefore required a renamed copy before the model could inspect them. Normalized local attachment objects exposed to the model use content digests without extensions, so their published read-only paths triggered the same refusal.

## Decision

`read_image` treats a file extension as a media-type declaration. PNG, JPEG, WebP, and GIF extensions select their declared types; another non-empty extension is refused before filesystem I/O, and the attachment store's full decode rejects a declaration that does not match the bytes. A path with no extension is read through `ctx.fs` under the existing `maxImageBytes` and tighter `maxMessageImageBytes` cap, then a tool-local `sniffImageMediaType` helper identifies one of the four supported file signatures. The detected type passes through the same deployment media-type policy and `saveImage` admission, whose full decode remains authoritative. This narrows the sniffing rejection in [the minimal read_image tool note](../feature/2026-08-10-minimal-read-image-tool.md) to extension-bearing paths.

The mounted `ctx.fs` backend is the complete path-authorization authority for `read_image`. Extensions and file signatures decide only whether the tool accepts bytes that the backend returned. Any valid extension-less image readable through that backend can enter the current session, including a normalized attachment object; the tool performs no session-reference proof and the attachment service exposes no reverse path lookup.

Admission failures name the offending path. An extension-less mismatch names the signature that supplied the declaration, while unsupported bytes report no file content.

## Alternatives considered

**Export signature identification from the attachment Service Definition package.** Only `read_image` needs this pre-admission declaration. Publishing the helper would make one Consumer's filename policy part of the provider-independent attachment API while the store already owns authoritative decoding.

**Special-case normalized attachment object paths.** Resolving a path back to a Session reference would make two files readable through the same `ctx.fs` behave differently according to their origin and would leave ordinary extension-less images unsupported. Filesystem access remains the read authorization decision.

**Add extensions to stored attachment objects.** This would change the storage layout and every object-path consumer to satisfy one tool's media-type declaration rule.

## Consequences

The model can read ordinary extension-less images and normalized attachment paths directly in native and PTC modes. Wrong extensions retain their pre-I/O refusal and mismatch repair. A non-image path without an extension is read up to the image byte cap before rejection, and a normalized object re-enters source admission instead of bypassing the current deployment limits. The behavior changes only `dsh-tool-fs`; the attachment Service Definition and local provider keep their existing APIs and storage behavior.
