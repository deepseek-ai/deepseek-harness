# DSH version and `engines.dsh`

Read the running DSH version before writing a version requirement. With `cordis_inspect`, pass `query: { platform: 'host', provider: 'Runtime', method: 'getVersion' }` and use the returned `version`; installation and activation check plugins against exactly this version. Otherwise use the version that `references/locate-docs.md` identifies. A `package.json` under the profile's `node_modules`, a lockfile, or an unrelated checkout may be an older copy and does not identify the running version.

Declare the versions the plugin supports as a SemVer range in `engines.dsh`. Use the running version as the lower bound, copied exactly with any prerelease suffix: for a running `0.2.2-alpha.2`, `^0.2.2` rejects it, while `^0.2.2-alpha.2` accepts it.

```json
{ "engines": { "dsh": "^0.2.2-alpha.2" } }
```

Prerelease versions take part in matching, so `^0.2.2-alpha.2` accepts `0.2.2-rc.1`, `0.2.2`, and `0.2.9`, but not `0.3.0`. When `engines.dsh` is present it alone decides; DSH peer dependencies are then ignored. Without it, every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` range in `peerDependencies` must match. An empty, invalid, or `workspace:` range in `engines.dsh` rejects every version; a non-string value makes the manifest malformed. A plugin without either declaration loads on any version. A refusal returns the `incompatible-version` code with `runtimeVersion` and the unmet `requirements`; correct the range rather than requesting a version exemption for a plugin you are writing.
