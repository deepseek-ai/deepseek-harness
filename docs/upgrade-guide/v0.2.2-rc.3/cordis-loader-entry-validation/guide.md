---
kind: upgrade-guide
description: "Cordis Loader 1.0.0-rc.9 and Include 1.2.0 parse YAML 1.2, reject malformed entries, and return PatchResult from applyEntryPatches."
---

# Loader validates entry options, and Include parses YAML 1.2

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/cordis-plugin-loader` now carries upstream Loader 1.0.0-rc.9, and `@deepseek-ai/cordis-plugin-include` carries Include 1.2.0. Hand-written `cordis.yml`, `cordis.patch.yml` and overlay files, and code that calls the Include or Loader exports, are affected:

- Include and `parseEntryYaml` parse YAML 1.2 under the core schema instead of the js-yaml JSON schema. A binary integer such as `0b101` now reads as the string `'0b101'`. An empty `!!js` scalar now reads as an empty expression, which evaluates to `undefined`, instead of failing to parse.
- Entry options are validated before an entry is created or updated. `name` must be a string; `group` a boolean; `disabled` a boolean or `!!js` expression; an entry with `group: true` must have a `config` list, even an empty one; `inject` a string list or a mapping; `isolate` a mapping whose values are `true` or a string. An entry that loaded before with such a value is now rejected and its siblings still start; `dsh` stops startup when the rejected entry is required, such as `webserver`, and warns otherwise. An Include file with an entry that is not a mapping is rejected as a whole. Ids containing `:` remain accepted.
- Parse, entry option and config validation errors name the file position as `file:line:column`. When an entry's own module cannot be found, the error is a `ModuleNotFoundError` without Node's `imported from` part; its `code` is still `ERR_MODULE_NOT_FOUND`.
- A patch that replaces a group's `config` brings child entries that later patches can address, and the children it replaces can no longer be patched.
- `applyEntryPatches(data, patches, warn)` returns `{ data, index }` instead of the entry list, and writes generated ids into the anonymous entries of a replaced group `config` in `patches`. `parseEntryYaml` throws the `YAMLError` of the `yaml` package instead of a js-yaml `YAMLException`.

## Migration

1. Write binary integers that must stay numbers in decimal or hexadecimal.
2. Run `dsh --dump-config` for each profile. A parse error now names its line and column; fix the reported value.
3. Add `config: []` to every `group: true` entry without `config`, such as a group whose children all come from patch `insert`. Start the profile and check the log for `invalid entry options` and `invalid config`. Correct each listed path at the position shown.
4. Where a later patch addressed a child of a group whose `config` an earlier patch replaced, check that the child now receives the patch.
5. In code, read `applyEntryPatches(...).data`, and pass `structuredClone(patches)` where the patch list must stay unchanged. Catch parse errors without depending on js-yaml types; `entryYamlErrorPosition(error)` still returns the position.
6. Confirm that `dsh --dump-config` prints the expected entries and that the profile starts without those diagnostics.
