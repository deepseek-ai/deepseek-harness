---
kind: upgrade-guide
description: "Creator mode replaces its four skills with one `dsh-doc` skill, and the repository documentation skill becomes `dsh-doc-writing`."
---

# `dsh-doc` replaces the Creator mode skills

English | [中文](guide.zh.md)

## Change

Creator mode offered four skills from `@deepseek-ai/dsh-agent-preset`: `cordis-plugin-development`, `editing-cordis-compositions`, `cordis-composition-reference`, and `agent-experience`. It now offers one skill, `dsh-doc`. Its former content is in files that `dsh-doc` reads on demand, under `skills/dsh-doc/references/` and `skills/dsh-doc/templates/` of that package. The old skill names no longer appear in the skill catalog, and loading one by name fails.

In a DSH source checkout, the documentation-writing skill `.agents/skills/dsh-doc` is now `.agents/skills/dsh-doc-writing`, named `dsh-doc-writing`.

This affects Creator mode users whose prompts, saved instructions, or own skills name an old skill, and compositions or scripts that read files at the old paths.

## Migration

1. Replace each old skill name in prompts, instructions, and skills with `dsh-doc`; for the source checkout documentation skill, use `dsh-doc-writing`.
2. Replace file paths under `@deepseek-ai/dsh-agent-preset/skills/` as follows:

   | Old path | New path |
   |---|---|
   | `cordis-plugin-development/SKILL.md` | `dsh-doc/references/plugin-development.md` |
   | `cordis-plugin-development/references/<file>` | `dsh-doc/references/<file>` |
   | `cordis-plugin-development/templates/<name>/` | `dsh-doc/templates/<name>/` |
   | `editing-cordis-compositions/SKILL.md` | `dsh-doc/references/compositions.md` |
   | `cordis-composition-reference/SKILL.md` | `dsh-doc/references/composition-reference.md` |
   | `cordis-composition-reference/references/packages.md` | `dsh-doc/references/packages.md` |
   | `agent-experience/SKILL.md` | `dsh-doc/references/tool-design.md` |

3. A composition that sets `customSkillDirs` to the package's `skills` directory needs no change.
4. Rename or remove a skill named `dsh-doc` in a project's `.dsh/skills/` or `.agents/skills/`: project skills take precedence and would hide the packaged one. In a DSH source checkout, update the checkout to a revision that contains this change, which renames the repository skill.
5. Start a new Creator mode session with an installation or revision that contains this change, and confirm that the skill catalog lists `dsh-doc` and none of the four skills this package shipped before.
