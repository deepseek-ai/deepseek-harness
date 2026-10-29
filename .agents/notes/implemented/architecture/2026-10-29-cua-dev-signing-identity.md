# Agent Note: Development signing identity for source-built CUA helpers

Status: implemented

English | [中文](2026-10-29-cua-dev-signing-identity.zh.md)

## Problem

Source checkouts compile `DSH Computer Use.app` with an ad-hoc signature. macOS stores Accessibility and Screen Recording grants for a bundle identifier with the designated requirement of the granted code, and an ad-hoc requirement is the code hash. Every changed build and every other worktree therefore needs new grants, and these builds shared the release helper's bundle identifier and replaced its grant entry.

## Decision

The Host builds source checkouts as a development variant with bundle identifier `com.deepseek.harness.computer-use.dev` and name `DSH Computer Use Dev`. The release variant and its packaging are unchanged. Grants stay with the helper application launched through LaunchServices, as the [shared helper decision](2026-10-09-cua-shared-native-helper.md) requires.

An explicit per-user setup command creates a self-signed code-signing certificate in a dedicated keychain, stores the random keychain password in an owner-only file beside it, allows `codesign` through the key partition list, and adds the keychain to the user keychain search list. `codesign` resolves identities only from that list. Development builds unlock the keychain with the stored password before every signature, so neither setup nor signing shows a password or key-access dialog. The resulting designated requirement names the bundle identifier and the certificate, so it is identical for every build signed on that machine, independent of code hash and path.

Certificate signatures embed a signing time even without a timestamp server. Development publication records which generation each unsigned bundle and identity produced, then selects that generation again instead of re-signing, so identical sources keep one executable digest and one shared service. Without setup, development builds use ad-hoc signatures and print the setup command. An explicit `--identity` overrides the local identity.

## Alternatives considered

**Grant the launching terminal.** Launching the service directly makes macOS attribute permissions to the terminal or editor that started DSH. Every program that application runs, including commands run by the model, then has the permissions.

**Separate bundle identifier with ad-hoc signatures.** This separates development grants from release grants, but every changed build still has a new code hash and needs new grants.

**Self-signed identity in the login keychain.** The login keychain is already unlocked and on the search list, but allowing `codesign` to use a new key there without a dialog requires the user's login password.

**Add the keychain to the search list only while signing.** The release packaging script does this for one invocation. Concurrent builds in several worktrees would read and restore the user list over each other, and a stopped build would leave the entry behind anyway.

**A stable launcher that spawns each worktree's helper.** Grants would follow the launcher, but any local process could ask it to run an arbitrary executable with those grants, which is the same exposure as the stored key without a signature check.

## Consequences

One grant covers all source checkouts and rebuilds of one macOS user. Any process of that user can read the keychain password and sign code that receives the development grants; the release helper's grants are unaffected, and the same user can already change the Swift sources that the next build signs. Setup changes the user keychain search list until the remove command runs. Grants already listed in System Settings stay there after removal. Existing ad-hoc source grants do not carry over; developers grant `DSH Computer Use Dev` once. `dev_signing_e2e.py` checks that two different builds share one designated requirement and that removal restores the search list.
