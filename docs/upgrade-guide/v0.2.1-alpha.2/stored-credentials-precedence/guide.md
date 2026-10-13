---
kind: upgrade-guide
description: "Stored credentials now precede environment fallbacks when the store is mounted; the shipped headless profile omits stored authentication."
---

# A stored key takes precedence over an exported variable

English | [中文](guide.zh.md)

## Change

Earlier releases used an exported environment variable before the `refs` entry with the same name in `$DSH_HOME/.credentials.yaml` (`~/.dsh/.credentials.yaml` by default). This applied to `DEEPSEEK_API_KEY=… dsh`, a shell profile export, a CI secret, and a container `-e` value. While the name was exported, the Models page could not save a key for it.

Now the stored entry wins. The exported variable applies only while the file stores no value for that name, and `$cwd/.env` and `$DSH_HOME/.env` still apply only after both. The Models page can save and replace a key while the name is exported.

The shipped `headless` profile instead disables the credential store, authorization and DeepSeek account provider. It uses the launch environment, project `.env`, then Harness-home `.env`, and leaves `.credentials.yaml` untouched. Saved API keys and sign-ins no longer authenticate headless jobs by default. Web, SDK and ACP retain the store.

You are affected when a harness home stores a value under `refs` and the process that launches `dsh` exports the same name. This includes a container that mounts such a home. Requests now use the stored key instead of the exported one. A CI job or container that starts with a fresh harness home, without `.credentials.yaml`, is not affected. The [stored credential precedence](../../../../.agents/notes/implemented/architecture/2026-10-09-stored-credential-precedence.md) Agent Note records the reason.

## Migration

1. Compare the names under `refs` in `$DSH_HOME/.credentials.yaml` with the variables that your shell, CI job, or container exports. A name that appears in only one place needs no action.
2. For each name that appears in both places, keep the stored key if it is the account you want. Otherwise, delete the name's line under `refs`. A running harness reloads the file, so the next request reads the exported variable without a restart.
3. For a headless job, export the required key and run `dsh headless "<task>"`. To keep using a saved key or sign-in, apply the three-row [headless restoration patch](../../../../packages/bundle/headless/README.md#credentials); restored storage also restores saved-first precedence. Existing profile, home or command overlays can override the shipped rows, so inspect `dsh headless --dump-config` when checking the effective composition.
4. Confirm the intended request account and that the launching process exports a non-empty value where needed. Check names and presence without printing credential values. A headless run relying only on a saved credential now fails; restoring storage or supplying supported environment authentication resolves it.
