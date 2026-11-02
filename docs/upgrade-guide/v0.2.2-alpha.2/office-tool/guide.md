---
kind: upgrade-guide
description: "Office operations move from shell-run Kit CLI paths to the Host-run office tool; renders save no image files, skill-office loses node and cli and gains pythonEnvironment, and Web and SDK mount Office skills."
---

# Office operations use the `office` tool

English | [中文](guide.zh.md)

## Change

Office rendering, conversion, and recalculation no longer run the LibreOffice Kit CLI through the shell. The [`@deepseek-ai/dsh-tool-office`](../../../../packages/document/tool-office/README.md) package registers a resident `office` tool. The shipped SDK profile and the `standard` and `ptc` presets of the Web and Desktop profiles mount it, so their requests declare it; `minimal` does not. Configurations and plugins that used the CLI path are affected:

| Removed | Replacement |
|---|---|
| `skill-office` configuration keys `node` and `cli` | None; the Office skills direct operations to the `office` tool |
| Node/CLI paths in the Office skills | The `office` tool; [removed operation skills](../office-operation-skills/guide.md) |
| `DSH_BUNDLED_OFFICE_CLI` and `DSH_BUNDLED_OFFICE_NODE` | None; no component reads them |

`DSH_BUNDLED_OFFICE_SKILLS`, `DSH_PRIMARY_RUNTIME`, and `DSH_BUNDLED_PRIMARY_RUNTIME` keep their meaning. The `office-kit` row gains `outputDirectory`, `outputRetentionMs`, and `maxOutputStoreBytes`.

`render` returns page images only for the model to view and saves no PNG or other image file. Converted and recalculated files return as temporary paths under `$DSH_HOME/office-kit/outputs` for the model to copy with the shell. A request to export pages as images gets an offer of a PDF export; for a file, call `office` with `operation: "convert"` and `format: "pdf"`.

The tool runs model-started Office work in the native LibreOffice Kit engine inside the Host process through `ctx.officeKit`, outside the shell sandbox and PTC permissions; inputs remain subject to the filesystem backend's read authority. The native parser processes untrusted documents with the Host user's permissions, affecting deployments that relied on the shell sandbox for document parsing.

`skill-office` gains `pythonEnvironment`. Its default, `'workspace-dependencies'`, directs the Python skills to `load_workspace_dependencies`; a composition without `@deepseek-ai/dsh-tool-workspace-dependencies` must set `'user'`.

The Web and SDK profiles mount the Office skills by default, including without a primary runtime; a new Session lists them in its first request context and the `/` menu.

## Migration

1. Remove `node` and `cli` from every `skill-office` row in `cordis.yml`, patches, and overlays.
2. Compositions that mount `@deepseek-ai/dsh-skill-office` without the shipped bundles also mount `@deepseek-ai/dsh-office-kit` and `@deepseek-ai/dsh-tool-office`, and set `pythonEnvironment: user` unless they mount `@deepseek-ai/dsh-tool-workspace-dependencies`.
3. Stop setting `DSH_BUNDLED_OFFICE_CLI` and `DSH_BUNDLED_OFFICE_NODE` in launchers.
4. Update expected first request contexts and `/` menus of Web or SDK Sessions to include the Office skills.
5. A `standard` or `ptc` preset saved from the Agent Preset editor replaces the shipped plugin list for that preset id, so its sessions lack the `office` tool. Add this row to the saved list in the editor, or to `config.plugins` of the `preset-standard` or `preset-ptc` row in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`<profile>`: `web` or `desktop`), then start a new session:

   ```yaml
   - id: tool-office
     name: '@deepseek-ai/dsh-tool-office'
   ```

6. Confirm: a new `standard` or `ptc` Session declares `office`, and `office` with `operation: "convert"` and `format: "pdf"` returns a temporary PDF path or the `unavailable` message.
