# Agent Note: File URLs for inserted patch plugins

Status: implemented

English | [中文](2026-09-05-patch-plugin-file-urls.zh.md)

## Problem

Node ESM interprets a Windows drive prefix as a URL scheme and treats filename fragments as URL syntax. Passing filesystem paths directly to plugin imports therefore fails for Windows absolute paths and filenames containing `#` or `%`.

## Decision

Patch-file parsing converts native absolute paths and patch-relative `./` or `../` names to file URLs inside `insert` rows and their nested groups. Package specifiers, existing URLs, existing-entry name assertions, and replacement `config` values retain their meaning. Parsing owns this conversion because it knows the originating patch directory before layers are composed.

The optional `HostResolvedRootInclude` import override separately converts absolute paths for callers selecting an installed-host resolver base. Ordinary CLI profiles do not select that override; it cannot substitute for patch-file conversion.

## Alternatives considered

**Convert only the Python fixture with `Path.as_uri()`.** This avoids one failure but leaves user-authored profile and overlay patches exposed.

**Change the shared Loader base.** This loses per-patch provenance and changes bare-package resolution. File URLs preserve the selected local file without changing the resolver base.

## Consequences

Optional and required patch readers share the conversion. Direct Loader imports and children introduced through replacement group configs remain outside its scope; extending those paths requires their own semantics and coverage.

The patch-reader tests verify conversion and real activation. The built SDK acceptance loads an absolute-path overlay plugin with URL-sensitive filename characters and verifies its filesystem marker, initialization, and shutdown.
