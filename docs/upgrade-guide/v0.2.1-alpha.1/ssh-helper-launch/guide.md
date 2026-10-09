---
kind: upgrade-guide
description: "SSH and Node PTC configurations use explicit launch modes, and SSH clients require a matching protocol-2 helper."
---

# SSH helper and PTC launch configuration

English | [中文](guide.zh.md)

## Change

Custom SSH compositions must update their `cordis.yml` and installed helper together. `dsh-ssh` replaces top-level `node`, `bootstrapPath` and `bootstrapHash` with `launch`, and requires SSH protocol 2. `dsh-ptc-runtime-node` replaces `nodeExecutable` and `bootstrapPath` with `launch`. The connection's `nodeExecutable` and `bootstrapPath` getters are replaced by `ptcLaunch`.

## Migration

1. For a script helper, move `node`, `bootstrapPath` and `bootstrapHash` under `launch: { kind: node-script }`. Keep `helper`, `helperHash`, `host` and `workspace` at their existing locations. Install the matching helper script and update `helperHash`; update the bootstrap and its hash together when configured.
2. For a packaged helper, extract the complete archive and set `launch: { kind: executable }`, `helper` to the executable's absolute remote path, and `helperHash` to its digest from `manifest.json`.
3. Configure the remote PTC provider with `launch: ctx.ssh.ptcLaunch` in the composition's existing JavaScript configuration. For an explicitly configured local Node worker, use `launch: { kind: 'node-script', executable: previousNodeExecutable, bootstrapPath: previousBootstrapPath }`. Omitted local launch configuration still selects the current process's runtime.
4. Start the configured profile and exercise a remote file read, a process command and a PTC call. A protocol or digest mismatch requires updating the installed helper and its configuration together. See the [SSH deployment requirements](../../../../packages/ssh/ssh/README.md#use-this-package).
