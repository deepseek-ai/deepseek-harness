# Agent Note: macOS consent shared by bundle identifier

Status: implemented

English | [中文](2026-10-25-cua-bundle-id-consent.zh.md)

## Problem

Users who install multiple versions of one application want one permission decision for that software. Executable paths split those decisions, and signing checks exclude unsigned development applications from saved access.

## Decision

macOS application consent uses the exact, case-sensitive native bundle identifier. The helper hashes `macos:bundle-id:` followed by that identifier into `CuaApplicationId`. When a bundle identifier exists, installation paths, versions and signatures do not distinguish grants. Otherwise, the helper hashes `macos:executable-path:` followed by the canonical executable path. Both identities support saved access; path identities survive restart and in-place updates, while a different path requires a new decision. Conversation decisions and saved grants retain the scopes and revocation behavior of [profile consent storage](2026-10-19-cua-profile-consent-storage.md).

This supersedes the executable/signature identity choice in [application consent](2026-09-26-cua-application-consent.md); that note still owns enforcement and human decisions. The running process path comes from the operating system. A valid runtime bundle identifier does not depend on path-query success. Missing paths omit optional grant metadata; they never substitute a cached catalog path. When both bundle identity and process path are unavailable, consent fails with the path query cause. Process identity must still be verified, and any available process path must match the selected target. Missing catalog path metadata does not block consent when the process path is available. If the runtime bundle identifier is unavailable, a reported application bundle can supply it only when its main executable matches the process path; otherwise the executable path identifies the grant. Native process, executable-location and window checks continue to bind each handle to its selected target. Launch checks reread the bundle identifier and executable path from disk; they do not fingerprint executable content. Replacing bytes at the same path while retaining the identifier or path identity therefore retains consent, including during an approval wait.

The identity prefixes separate new grants from old path/signature, process-instance and executable-content digests. Old grants remain removable but do not grant access to new bundle identities; users decide again before permission covers other installations.

Apple’s [PPPC configuration](https://support.apple.com/guide/deployment/privacy-preferences-policy-control-payload-dep38df53c2a/web) supports bundle-ID or path selectors and separately requires a code-signing requirement. [TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) explains that designated requirements track code identity across versions, while unsigned and ad-hoc code cannot provide the same stability. DSH adopts the selector alternatives for application management without requiring publisher authentication.

## Alternatives considered

**Bundle identifier and path.** This distinguishes installed copies but requires separate decisions for the multiple versions the user wants to authorize together.

**Bundle identifiers only.** Missing identifiers would exclude otherwise usable applications from saved access. Canonical executable paths supply a stable fallback without using a PID or content hash.

**Verified signing identity.** This distinguishes publishers but denies saved access when signing is absent or cannot be verified. Publisher authentication is outside this application-management policy.

## Consequences

Another program declaring the same bundle identifier or replacing an executable at its approved fallback path inherits consent, including a program created or changed through separately authorized model tools. The worst consequence is observing or controlling an application that the user did not approve separately, within its available data and capabilities. The model cannot supply the authorization identity through the CUA request; the native helper reads it from the selected application. Different bundle identifiers require different decisions, even when users consider them versions of one product.

Revocation applies to every installation sharing the identifier. Tests exercise unsigned copies, different identifiers, missing identifiers with persistent path consent, process restarts, symlink aliases, pending and running identity agreement, shared handle revocation and refusal to widen old grants.
