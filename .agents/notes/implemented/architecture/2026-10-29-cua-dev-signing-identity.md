# Agent Note: Development signing identity for source-built CUA helpers

Status: implemented

English | [中文](2026-10-29-cua-dev-signing-identity.zh.md)

## Problem

Source checkouts compile `DSH Computer Use.app` with an ad-hoc signature. macOS stores Accessibility and Screen Recording grants for a bundle identifier with the designated requirement of the granted code, and an ad-hoc requirement is the code hash. Every changed build and every other worktree therefore needs new grants, and these builds shared the release helper's bundle identifier and replaced its grant entry.

## Decision

The Host builds source checkouts as a development variant with bundle identifier `com.deepseek.harness.computer-use.dev` and name `DSH Computer Use Dev`, in `DSH Computer Use Dev.app`. The macOS privacy list and the helper’s reported launch application use the bundle filename, so that filename also includes Dev. The release variant and its packaging are unchanged. Grants stay with the helper application launched through LaunchServices, as the [shared helper decision](2026-10-09-cua-shared-native-helper.md) requires.

`sourceSigning` belongs to the macOS provider and accepts `ad-hoc`, default `local-identity`, or `{ identity, keychain? }` for an existing certificate. The generated identity and password live under `$DSH_HOME/computer-use-dev-signing`, using `~/.dsh` when no home is configured. The first build creates the certificate and later builds using that home reuse it. The Host uses the shared home-path resolver and passes the result to Python. Ad-hoc and user-certificate modes do not read or create the generated identity; users own unlocking and maintaining their certificates.

Setup creates a self-signed certificate in a dedicated keychain, stores a random password in a `0600` file, permits codesign through the key partition list, and adds the keychain to the user search list. Automatic builds unlock it before signing to avoid password or key-access dialogs. A file lock serializes setup and removal within the same home. A recorded identity with a missing keychain is preserved and rejected until the user explicitly removes it. The signing requirement contains the bundle identifier and certificate, independent of code hash or path for builds using that certificate.

Certificate signatures embed a signing time even without a timestamp server. Development publication records which generation each unsigned bundle and identity produced, then selects that generation again instead of re-signing, so identical sources keep one executable digest and one shared service. The cache uses certificate fingerprints; explicit certificate names are not reused because renewal can change the certificate behind a name. Setup failures stop the build, and diagnostics omit passwords and complete command arguments. `--identity` selects user-certificate signing and is mutually exclusive with `--signing`.

## Alternatives considered

**Grant the launching terminal.** Launching the service directly makes macOS attribute permissions to the terminal or editor that started DSH. Every program that application runs, including commands run by the model, then has the permissions.

**Ad-hoc signing by default.** This avoids storing a private key but can require new grants when binaries change. Automatic fixed signing removes manual certificate setup from ordinary source builds; ad-hoc signing remains an explicit option.

**Self-signed identity in the login keychain.** The login keychain is already unlocked and on the search list, but allowing `codesign` to use a new key there without a dialog requires the user's login password.

**Add the keychain to the search list only while signing.** The release packaging script does this for one invocation. Concurrent builds in several worktrees would read and restore the user list over each other, and a stopped build would leave the entry behind anyway.

**A stable launcher that spawns each worktree's helper.** Grants would follow the launcher, but any local process could ask it to run an arbitrary executable with those grants, which is the same exposure as the stored key without a signature check.

## Consequences

Automatic builds using the same DSH home share a signing requirement; actual permission retention across rebuilds and worktrees still needs manual verification. Other processes of the same user can read the password and sign with the development identity; the release helper uses a different bundle identifier. Deleting DSH home removes the generated identity, so the next build creates another certificate and needs new grants; home reset therefore clears signing state too. System permission entries and the keychain search entry survive directory deletion; subsequent setup removes a stale search entry at the same path. Select ad-hoc or user-certificate signing before explicit removal to prevent regeneration. The real signing e2e checks requirements across output directories, user-selected certificates, and search-list restoration after removal.
