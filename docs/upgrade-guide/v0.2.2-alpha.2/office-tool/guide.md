---
kind: upgrade-guide
description: "Office operations move from shell-executed Kit CLI paths to the office tool, removing the skill-office node and cli keys and the Office executable variables, adding pythonEnvironment, and mounting Office skills in Web and SDK by default."
---

# Office operations use the `office` tool

English | [中文](guide.zh.md)

## Change

Office rendering, conversion, and recalculation no longer run the LibreOffice Kit CLI through the shell. The new [`@deepseek-ai/dsh-tool-office`](../../../../packages/document/tool-office/README.md) package registers a resident `office` tool that runs Kit inside the Host through `ctx.officeKit`. Rendered pages return as images in the tool result; converted and recalculated files return as temporary paths under `$DSH_HOME/office-kit/outputs` for the model to copy with the shell. The shipped SDK profile and the `standard` and `ptc` agent presets of the Web and Desktop profiles mount it, so their requests now declare the `office` tool; the `minimal` preset does not. Compositions, launchers, and plugins that configured or consumed the CLI path are affected:

| Removed | Replacement |
|---|---|
| `skill-office` configuration keys `node` and `cli` | None; operation skills call the `office` tool |
| `## Installed LibreOffice Kit` section and Node/CLI paths in `office-render`, `office-export-pdf`, and `office-recalculate` | The `office` tool |
| `DSH_BUNDLED_OFFICE_CLI` and `DSH_BUNDLED_OFFICE_NODE` | None; no component reads them |

`DSH_BUNDLED_OFFICE_SKILLS`, `DSH_PRIMARY_RUNTIME`, and `DSH_BUNDLED_PRIMARY_RUNTIME` keep their meaning. The `office-kit` row gains `outputDirectory`, `outputRetentionMs`, and `maxOutputStoreBytes`.

`skill-office` gains `pythonEnvironment`. Its default, `'workspace-dependencies'`, directs the Python skills to `load_workspace_dependencies`; a composition that does not mount `@deepseek-ai/dsh-tool-workspace-dependencies` must set `'user'`, which directs them to the user's Python.

The Web and SDK profiles now mount the Office skills by default, including without a primary runtime. The first request context of a new Session lists them in the skill catalog, and the `/` menu offers them.

## Migration

1. Remove `node` and `cli` from every `skill-office` row in `cordis.yml`, patches, and overlays; they have no effect.
2. In custom compositions that mount `@deepseek-ai/dsh-skill-office` without the shipped bundles, also mount `@deepseek-ai/dsh-office-kit` and `@deepseek-ai/dsh-tool-office` so the operation skills can run, and set `pythonEnvironment: user` unless the composition mounts `@deepseek-ai/dsh-tool-workspace-dependencies`.
3. Stop setting `DSH_BUNDLED_OFFICE_CLI` and `DSH_BUNDLED_OFFICE_NODE` in launchers and shell wrappers.
4. Update expected first request contexts and `/` menus of Web or SDK Sessions to include the Office skills.
5. If you saved a `standard` or `ptc` preset from the Agent Preset editor in the Web or Desktop application, the saved plugin list replaces the shipped one for that preset id, so sessions in that preset do not get the `office` tool. Add this row to the saved preset's plugin list, either with the Agent Preset editor or in the `config.plugins` list of the `preset-standard` or `preset-ptc` row in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`<profile>` is `web` or `desktop`), then start a new session:

   ```yaml
   - id: tool-office
     name: '@deepseek-ai/dsh-tool-office'
   ```

6. Confirm the migration by loading `office-export-pdf`: its body names the `office` tool and contains no executable paths, and calling `office` with `operation: "convert"` and `format: "pdf"` returns a temporary PDF path or the `unavailable` message.
