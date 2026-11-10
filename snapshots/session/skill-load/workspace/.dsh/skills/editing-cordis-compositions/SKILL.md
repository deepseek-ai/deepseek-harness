---
name: editing-cordis-compositions
description: Use when creating, changing, or validating an agent preset or other Cordis composition for this harness, including deciding host versus preset placement and checking that an authored preset mounts.
---

# Editing Cordis compositions

Agent presets are ordinary `@deepseek-ai/dsh-agent-preset` declarations carried by bundle patches. Nothing edits a declaration in place: a preset is created or changed by installing a bundle whose patch declares or overrides it. This file states the declaration format; when it leaves a question open, read the `@deepseek-ai/dsh-agent-preset` README and `lib/types` declarations under the `packageDir` that `cordis_inspect_query` `Config.listConfigs` returns when queried with a `preset-<id>` row's `entry` id, or `packages/preset/agent-preset/src` in a source checkout.

## Where declarations live

The shipped Web presets are `presets/<id>.patch.yml` files of the `@deepseek-ai/dsh-web-app` bundle, ids `standard`, `ptc`, `minimal` and `cordis`. Installed, the bundle resolves from the dsh installation, not the profile; querying `Config.listConfigs` with the `entry` id of any `preset-<id>` row it declares returns that `packageDir`. In a source checkout of DSH it is `packages/bundle/web-app/`. Read one file with the file-read tool when you need a template; `minimal.patch.yml` is the shortest. In Desktop the bundle sits inside `app.asar`, which shell commands cannot open. Load `cordis-composition-reference` for the patch dialect and the list of plugin packages a preset can mount.

A declaration row has these `config` fields: `id` (required, lowercase letters, digits and hyphens), `plugins` (required Cordis entry list), and optional `name`, `description` and `order` (roster position). The Loader row `id` is `preset-<id>` by convention.

## Create a preset

Write a bundle directory in the workspace with exactly two files, then install it.

`review-preset/package.json`:

```json
{
  "name": "@local/dsh-review-preset",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`review-preset/cordis.patch.yml`:

```yaml
- insert:
    - id: preset-review
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: review
        name: Review
        description: Reviews changes with the shell only.
        order: 10
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You review software changes.
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
```

Install with `plugin_manager`, `action: install_bundle`, `target` set to the absolute bundle directory. It runs package installation and bundle selection itself; do not reproduce those steps with shell commands.

## Change a shipped preset

Override the declaration by its Loader row id instead of inserting. The override replaces the complete `config`, so restate `id`, `plugins` and every other field the shipped file carries:

```yaml
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      # the shipped list with your changes
```

## Migrate a legacy preset

Before declaration rows, a user preset was a directory `$DSH_HOME/.agent-presets/<id>/` holding `preset.yml` (display `name`, `description`, `order`) and `agent.cordis.yml` (the plugin entry list). Nothing reads that directory any more. To migrate one, create a bundle as above whose declaration takes `id` from the directory name, `name`, `description`, and `order` from `preset.yml`, and `plugins` from `agent.cordis.yml` verbatim; check each plugin name against `cordis-composition-reference` because packages renamed since the preset was written fail at activation. Install it, verify the row, then delete the legacy directory.

## Verify

`plugin_manager` `list_bundles` lists the installed bundle; `list_plugins` shows the `preset-<id>` row with its activation state. A declaration whose activation fails stays on the roster with its diagnostic and cannot compose a session until the bundle is fixed and reinstalled. Existing sessions and their children keep the plugin revision they started with; validate changed behavior in a new session. Installing a bundle executes plugin code in the Host process, so it requires Full access or approval.

## Choose plugin placement

Host plugins supply shared services: tools and prompt registries, the Agent loop, sessions, persistence, settings, sandbox policy, model routes, and subagent backends. Preset plugins contribute scoped tools, persona, prompt sections, and policies to those registries. Preset revisions are eagerly activated once and shared by their selecting Agents.

A preset plugin that supplies a service must isolate the provider and all its consumers in the same realm. A service consumed by Host plugins belongs in the Host configuration. Scope controls contributions and event visibility; `isolate` controls service instances. Use ordinary Cordis groups for nested plugin lists. Keep `!!js` expressions only in plugin configuration or `disabled`; the Loader evaluates them when activating the child plugin. Resolve assets from installed packages rather than a preset directory.

## Extend the Host

For new plugin code or profile-wide capabilities, load `cordis-plugin-development`, author a workspace bundle, and install it with `plugin_manager`. Inspect available APIs through `cordis_inspect_list` and `cordis_inspect_query`, including a mounted plugin's Config schema through the Host `Config` provider; those tools do not invoke Remote methods. Verify the installed capability before reporting completion.
