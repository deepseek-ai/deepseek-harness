---
kind: upgrade-guide
description: "`DSH_BUNDLED_OFFICE_SKILLS` and the `office-skills/` resource directories are removed; Office skills load from the `skill-office` package's assets."
---

# Office skills load from the packaged assets

English | [中文](guide.zh.md)

## Change

The Web and SDK profiles no longer set `assetRoot` on the `skill-office` row, so [`@deepseek-ai/dsh-skill-office`](../../../../packages/skill/skill-office/README.md) reads the Office skills from its packaged `assets/` in every deployment:

| Removed | Replacement |
|---|---|
| `DSH_BUNDLED_OFFICE_SKILLS` | `assetRoot` in a profile patch, or same-name filesystem skills |
| Desktop `resources/runtime/office-skills/` | The skill package inside `resources/app.asar` |
| Python runtime wheel `<platform>-<arch>/office-skills/` | The skill package inside the runtime executable |
| `office-skills/` beside `primary-runtime/` in `pnpm run prepare:primary-runtime` output and the downloaded authoring payload | None |

`pythonEnvironment` and its values are unchanged. This affects launchers that set `DSH_BUNDLED_OFFICE_SKILLS`, tools that read or edit skill files in those directories, and container images that copy `office-skills/` beside `primary-runtime/`.

## Migration

1. Stop setting `DSH_BUNDLED_OFFICE_SKILLS`. To keep a custom skill directory, set `assetRoot` in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. A patch replaces the row's whole `config`, so also set `pythonEnvironment: user` unless the profile mounts `workspace-dependencies`, which requires a nonempty `DSH_PRIMARY_RUNTIME` in Desktop and the SDK:

   ```yaml
   - id: skill-office
     config:
       assetRoot: /absolute/path/to/office-skills
       pythonEnvironment: user
   ```

2. Alternatively, place a skill named `office`, `office-docx`, `office-pptx`, or `office-xlsx` in a [project or user skill directory](../../../../packages/skill/skill-filesystem/README.md); filesystem skills take precedence over the bundled skills with the same name.
3. Remove steps that copy or read `office-skills/` in Desktop resources, Python wheels, or prepared primary-runtime payloads. Containers copy only `primary-runtime/` and keep `DSH_PRIMARY_RUNTIME` pointing at it.
4. Confirm: in a new Session, load `office-docx`; its result names a base directory under the skill package's `assets/`, under the configured `assetRoot`, or in the overriding skill directory.
