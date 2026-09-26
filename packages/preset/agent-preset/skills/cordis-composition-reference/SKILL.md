---
name: cordis-composition-reference
description: Use when writing or reading a Cordis bundle patch or agent preset for this harness and you need the Loader YAML dialect (insert, override by id, group, disabled, isolate, !!js) or the list of installable Harness plugin packages and what each provides.
---

# Cordis composition reference

Reference material for bundle patches and preset plugin lists. Procedures live in `cordis-plugin-development` and `editing-cordis-compositions`.

## Loader patch dialect

A profile composes an ordered list of patch layers over the bundle entry lists. Each patch is a mapping:

- `insert: [rows]` appends rows; with an `id` naming an existing `group: true` row, the rows are appended inside that group's `config` list.
- A patch with an `id` and no `insert` targets the existing row with that id. Supplied fields replace the row's fields; `config` is replaced wholesale, never deep-merged, so restate every field the row needs. A truthy `name` asserts the existing plugin name rather than renaming it.
- Non-insert patches without a nonempty `id`, and targets that match no row, are warned about and skipped.

A row has `id`, `name` (the plugin package specifier; inserted relative paths are anchored beside their patch file), optional `config`, and optional `disabled`, `inject`, `intercept`, and `isolate`.

- `group: true` with `name: cordis:group` makes `config` a nested entry list and allows patches to insert into it by id. `cordis:include` loads a literal YAML or JSON entry list from `config.path`.
- `disabled` accepts a boolean, null, or a `!!js` expression evaluated against the Loader context at every mount decision. A disabled row omits required `config` unless `group: true` forces activation.
- `!!js` scalars are Loader expressions, never `!js`. Inside `config` they are evaluated after the row's declared injections activate, against that plugin's context (`ctx.<service>`), so `!!js dshHomePath('sessions')` and `!!js "!ctx.get('profileContext')"` are valid. Other row metadata stays literal.
- `isolate` maps service names to `true` or a realm label; a preset plugin that provides a service isolates the provider and all consumers together. Scope controls contributions and event visibility; `isolate` controls service instances.

`plugin_manager` `list_plugins` reports each row's `enabled` flag and `fiberPhase`; `set_plugin` and `set_bundle` answer `overridden` when a higher-priority layer wins.

## Installable plugin packages

`references/packages.md` lists every workspace package that exports a Cordis plugin, grouped by package group, with whether its row takes `config`. Search it with `grep -n <keyword>` rather than reading it whole. Plugins outside this list come from installed bundles; `plugin_manager` `list_bundles` names them.
