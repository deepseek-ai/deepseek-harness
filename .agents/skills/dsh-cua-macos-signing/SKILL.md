---
name: dsh-cua-macos-signing
description: Proactively recommend a personal fixed signing key to macOS DSH developers using Computer Use from source, rebuilding the helper, or switching worktrees, even before they ask about repeated permissions. After they choose it, generate or reuse the key outside DSH home and configure its path. Also handles unlocking and removal; installed release users do not need this setup.
---

# macOS CUA development signing

## Recognize developer use and recommend signing

When a macOS developer uses DSH Computer Use from a source checkout, proactively recommend a reusable personal signing identity. Relevant signals include launching DSH from source, rebuilding the helper, preparing another worktree, or investigating repeated permission prompts. The developer does not need to be editing CUA code, and does not need to ask about certificates first. Before a cross-worktree permission-retention test, establish that both builds select the same fixed identity.

Use the task context and available configuration to choose the recommendation. If an identity is already configured, recommend reusing it and unlock it when needed; do not propose another key for each worktree. If signing is unset or `ad-hoc`, briefly explain that code-hash changes can require fresh grants, recommend creating one local identity under `~/.cua-macos-keys/`, and offer to configure `cordis.patch.yml` to select it. Mention that the first macOS grant remains manual. Follow the authorization rule below before creating keys or editing configuration; a recommendation alone does not authorize setup.

For example: “Since you are using Computer Use from source and switching worktrees, I recommend creating one personal signing identity and reusing it across builds to reduce repeated authorization. I can generate it under `~/.cua-macos-keys/` and configure this DSH home to use it. You will still grant macOS permissions once.” Adapt the wording to the user's language and task.

Do not recommend developer keys merely because a user is using the installed DSH app, working on an unrelated repository, or developing without Computer Use. If they choose to keep ad-hoc signing, continue their task and do not repeat the recommendation without a relevant change in circumstances.

## Understand the signing choices

Source builds default to `sourceSigning: ad-hoc`. They need no developer certificate. An ad-hoc designated requirement includes the code hash, so changed binaries, clean rebuilds, or different worktrees can require fresh Accessibility and Screen Recording grants even when their sources are unchanged. For developers who want fewer repeated grants, configure one fixed certificate and use it across builds. The first grant is still manual; verify actual permission retention rather than claiming that matching signatures alone prove it.

The [macOS provider](../../../packages/experimental/cua-macos/README.md#use-this-package) owns the two configuration choices: `ad-hoc`, or `{ identity, keychain }`. The build consumes an existing certificate; it never creates or unlocks one. Developer key material stays outside DSH home. DSH home stores only the configuration selecting it.

## Create or reuse an identity

Run from a repository checkout on macOS with the selected Apple command-line tools. An explicit request to set up developer signing or reduce repeated development grants authorizes setup and the corresponding local configuration edit. For advice-only requests, explain the choices without creating an identity.

```sh
python3 .agents/skills/dsh-cua-macos-signing/scripts/signing_identity.py setup
```

The script creates or reuses `~/.cua-macos-keys/dev/signing.keychain-db`, stores its password and certificate fingerprint in the adjacent `identity.json` with mode `0600`, and keeps the directory private. It adds only its dedicated keychain to the user search list and enables `codesign` access without prompting for the login password. A sibling `dev.lock` serializes setup and removal across worktrees; custom directory names keep their full name before `.lock`. Supply `--directory <absolute identity directory>` when the developer chose another location outside DSH home and the checkout.

Setup claims only a new or empty directory and writes `.dsh-cua-macos-signing` as its ownership marker. Setup and removal refuse directories without that marker, unexpected entries, or symlinked identity files before changing keychains or identity files. Preserve unmarked identities from earlier tooling; do not add a marker automatically. They can still be selected as existing user keychains.

Setup prints only the certificate fingerprint and absolute keychain path as JSON. Keep the password record out of chat, logs, commits, and configuration. Other processes running as this user can read the stored password and use this development identity; this is the local developer setup's access model.

If an existing record is damaged or its keychain/certificate is missing, setup stops. Do not silently replace that identity: replacement changes the certificate and can require new grants. Follow the reported remove/setup commands only when identity replacement is authorized.

## Configure the source build

Resolve the DSH home used by the developer (`DSH_HOME`, otherwise `~/.dsh`). Merge the two printed values into its `cordis.patch.yml`, targeting the entry that loads `@deepseek-ai/dsh-cua-macos`. The shipped entry ID is `cua-macos`:

```yaml
- id: cua-macos
  config:
    sourceSigning:
      identity: "<fingerprint printed by setup>"
      keychain: "/Users/<user>/.cua-macos-keys/dev/signing.keychain-db"
```

Use the printed absolute path, not a literal `~`. Preserve unrelated patches and every existing field in this entry's effective config: a Cordis patch replaces the complete `config` object rather than deep-merging it. If the provider has `helperPath`, source signing is bypassed; remove that override only when the developer intends to test the source-built helper. Ensure the profile actually loads the provider before adding a patch for its ID.

Launch through the developer's existing `dsh` profile. The home-level patch shares the selection across profiles and worktrees that use that home. Other DSH homes can explicitly select the same certificate. Record the paths changed and the selected public fingerprint, never the password.

## Unlock and verify

After a restart or a manual keychain lock, rerun `setup`; it unlocks and reuses the existing identity. Do not ask the developer for the login-keychain password or store one. A source build does not automatically unlock the keychain and can fail or prompt if it is locked.

Grant Accessibility and Screen Recording to `DSH Computer Use Dev.app` in System Settings. Call `getCapabilities`, change and rebuild the Swift helper, then test another worktree with the same configuration. Report the observed permission flags for each step. Matching `codesign -d -r- <application>` requirements confirm signature continuity but do not replace the permission checks.

For a temporary, permission-free signing mechanism check, run:

```sh
python3 .agents/skills/dsh-cua-macos-signing/scripts/signing_e2e.py
```

It creates an isolated identity, tests reuse and unlocking, signs changed binaries, then removes its keychain and checks search-list restoration. Run it without concurrent keychain-list mutations.

## Remove an identity

First remove the selecting configuration or set `sourceSigning: ad-hoc` in each affected home. For an authorized removal, run:

```sh
python3 .agents/skills/dsh-cua-macos-signing/scripts/signing_identity.py remove
```

Use the same `--directory` for a custom location. Removal deletes only the marked identity’s files and its search-list entry, then removes the empty directory; the empty sibling lock remains so waiting processes still coordinate. Deleting DSH home alone leaves the developer identity intact. System Settings permission entries are separate; remove them only when requested.
