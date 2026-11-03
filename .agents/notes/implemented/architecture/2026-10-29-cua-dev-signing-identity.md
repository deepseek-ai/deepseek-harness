# Agent Note: Development signing identity for source-built CUA helpers

Status: implemented

English | [中文](2026-10-29-cua-dev-signing-identity.zh.md)

## Problem

Source checkouts compile `DSH Computer Use.app` with an ad-hoc signature. macOS stores Accessibility and Screen Recording grants for a bundle identifier with the designated requirement of the granted code, and an ad-hoc requirement is the code hash. Every changed build and every other worktree therefore needs new grants, and these builds shared the release helper's bundle identifier and replaced its grant entry.

## Decision

The Host builds source checkouts as a development variant with bundle identifier `com.deepseek.harness.computer-use.dev` and name `DSH Computer Use Dev`, in `DSH Computer Use Dev.app`. The macOS privacy list and the helper’s reported launch application use the bundle filename, so that filename also includes Dev. The release variant and its packaging are unchanged. Grants stay with the helper application launched through LaunchServices, as the [shared helper decision](2026-10-09-cua-shared-native-helper.md) requires.

`sourceSigning` belongs to the macOS provider and accepts only default `ad-hoc` or `{ identity, keychain }` selecting an existing certificate and absolute keychain path. Builds do not create, unlock or remove identities. Developer credentials stay separate from the user-facing DSH home, which stores only the certificate selection; the shared `cua` package owns no macOS signing configuration.

The [developer signing skill](../../../skills/dsh-cua-macos-signing/SKILL.md) guides Agents through creating, reusing and unlocking an isolated identity under `~/.cua-macos-keys/`, then selecting its fingerprint and keychain path in user configuration. The tool stores a random password in a `0600` file, permits codesign access, and adds the dedicated keychain to the user search list. A file lock serializes setup and removal for that directory; a missing keychain with an existing record is preserved and rejected. A directory marker limits identity management to explicitly claimed, initially empty directories. Unexpected files or symlinked identity entries stop setup and removal before changes, so a developer-selected path cannot erase unrelated contents.

Certificate signatures embed a signing time even without a timestamp server. Development publication records which generation each unsigned bundle and identity produced, then selects that generation again instead of re-signing, so identical sources keep one executable digest and one shared service. The cache uses certificate fingerprints; explicit certificate names are not reused because renewal can change the certificate behind a name. Signing failures stop publication. Developer setup diagnostics omit passwords and complete command arguments. The build CLI defaults to `--identity -` and accepts an existing certificate with `--identity` and optional `--keychain` for release packaging.

## Alternatives considered

**Grant the launching terminal.** Launching the service directly makes macOS attribute permissions to the terminal or editor that started DSH. Every program that application runs, including commands run by the model, then has the permissions.

**Automatically create a fixed identity during source builds.** This makes ordinary startup create developer private keys and ties their lifetime to user data. An explicit developer workflow preserves the option to reduce repeated grants while keeping identity creation, removal and selection under developer control.

**Self-signed identity in the login keychain.** The login keychain is already unlocked and on the search list, but allowing `codesign` to use a new key there without a dialog requires the user's login password.

**Add the keychain to the search list only while signing.** The release packaging script does this for one invocation. Concurrent builds in several worktrees would read and restore the user list over each other, and a stopped build would leave the entry behind anyway.

**A stable launcher that spawns each worktree's helper.** Grants would follow the launcher, but any local process could ask it to run an arbitrary executable with those grants, which is the same exposure as the stored key without a signature check.

## Consequences

Development builds signed by the same certificate share a signing requirement; actual permission retention after grants, rebuilds and worktree changes still requires verification. Other processes of the same user can read the stored password and sign with that identity; the release helper has a different bundle identifier. Deleting DSH home removes its selection, not the developer identity; deleting the identity requires clearing every configuration that references it. The real-signing e2e checks reuse, unlocking, requirements across output directories and search-list restoration after removal.
