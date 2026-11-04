---
kind: upgrade-guide
description: "The `office-render`, `office-recalculate`, and `office-export-pdf` skills, the skill-office `node` and `cli` keys, and two Office CLI environment variables are removed; Office operations use skill-activated tools."
---

# Office operation skills are replaced by Office tools

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-skill-office` no longer registers the `office-render`, `office-recalculate`, and `office-export-pdf` skills; it registers the `office` router and the `office-docx`, `office-pptx`, and `office-xlsx` authoring skills. After an Office skill loads, the model calls [`office_render`, `office_convert`, and `office_recalculate`](../../../../packages/document/tool-office/README.md) from the following step.

Configuration changes:

| Removed | Replacement |
|---|---|
| `skill-office` keys `node` and `cli` | None; Office tools convert in the Host |
| `DSH_BUNDLED_OFFICE_CLI` and `DSH_BUNDLED_OFFICE_NODE` | None; no component reads them |
| `DSH_BUNDLED_PRIMARY_RUNTIME` | `DSH_PRIMARY_RUNTIME` |

`skill-office` gains `pythonEnvironment`. Its default, `'workspace-dependencies'`, directs the Python skills to `load_workspace_dependencies`; a composition without `@deepseek-ai/dsh-tool-workspace-dependencies` must set `'user'`. `DSH_BUNDLED_OFFICE_SKILLS` keeps its meaning.

The Office tools parse untrusted documents with the native LibreOffice Kit engine in the Host process, outside the shell sandbox and PTC permissions, with the Host user's permissions; the filesystem backend still authorizes inputs. The `office-kit` row gains `outputDirectory` (default `$DSH_HOME/office-kit/outputs`), `outputRetentionMs`, and `maxOutputStoreBytes`.

This affects users and prompts of the removed skills, compositions and launchers setting the removed keys or variables, `assetRoot` skill copies, saved `standard` or `ptc` presets, and deployments relying on the shell sandbox for document parsing.

## Migration

1. Replace each removed skill with loading `office` and calling the matching tool:
   - `office-render`: `office_render`;
   - `office-recalculate`: `office_recalculate` with `format: "xlsx"` or `"ods"`;
   - `office-export-pdf`: `office_convert` with `format: "pdf"`.
2. Remove `node` and `cli` from every `skill-office` row in `cordis.yml`, patches, and overlays. Set `pythonEnvironment: user` unless the composition mounts `@deepseek-ai/dsh-tool-workspace-dependencies`.
3. Compositions that mount `@deepseek-ai/dsh-skill-office` without the shipped bundles also mount `@deepseek-ai/dsh-office-kit` and `@deepseek-ai/dsh-tool-office`.
4. In launchers, stop setting `DSH_BUNDLED_OFFICE_CLI` and `DSH_BUNDLED_OFFICE_NODE`, and rename `DSH_BUNDLED_PRIMARY_RUNTIME` to `DSH_PRIMARY_RUNTIME`. The Python SDK prefers a set or inherited `DSH_PRIMARY_RUNTIME`, even empty, over its download cache; unset it to use the cache.
5. In a copy referenced by `assetRoot`, replace the four remaining folders with the installed package's `assets/` and delete the three removed skill folders.
6. A `standard` or `ptc` preset saved from the Agent Preset editor replaces the shipped plugin list, so its Sessions lack the Office tools. Add this row to the saved list, or to `config.plugins` of the `preset-standard` or `preset-ptc` row in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`<profile>`: `web` or `desktop`):

   ```yaml
   - id: tool-office
     name: '@deepseek-ai/dsh-tool-office'
   ```

7. Deployments that require sandboxed document parsing omit `@deepseek-ai/dsh-tool-office`.
8. Confirm: in a new Desktop `standard` or `ptc` Session, send `/office`, then a separate PDF export request; it produces an `office_convert` call that returns a temporary PDF path or the `unavailable` message.
