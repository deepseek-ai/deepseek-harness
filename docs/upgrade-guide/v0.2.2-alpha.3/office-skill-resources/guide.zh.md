---
kind: upgrade-guide
description: "`DSH_BUNDLED_OFFICE_SKILLS` 和 `office-skills/` 资源目录被删除；Office 技能从 `skill-office` 包的 assets 加载。"
---

# Office 技能从包内 assets 加载

[English](guide.md) | 中文

## 变更

Web 和 SDK profile 不再为 `skill-office` 行设置 `assetRoot`，因此 [`@deepseek-ai/dsh-skill-office`](../../../../packages/skill/skill-office/README.zh.md) 在所有部署中都从包内 `assets/` 读取 Office 技能：

| 已删除 | 替代 |
|---|---|
| `DSH_BUNDLED_OFFICE_SKILLS` | profile patch 中的 `assetRoot`，或同名文件系统技能 |
| Desktop `resources/runtime/office-skills/` | `resources/app.asar` 内的技能包 |
| Python 运行时 wheel 的 `<platform>-<arch>/office-skills/` | 运行时可执行程序内的技能包 |
| `pnpm run prepare:primary-runtime` 输出和下载的创作载荷中与 `primary-runtime/` 同级的 `office-skills/` | 无 |

`pythonEnvironment` 及其取值不变。受影响的有：设置 `DSH_BUNDLED_OFFICE_SKILLS` 的启动器，读取或编辑上述目录中技能文件的工具，以及把 `office-skills/` 复制到 `primary-runtime/` 旁边的容器镜像。

## 迁移

1. 不再设置 `DSH_BUNDLED_OFFICE_SKILLS`。要继续使用自定义技能目录，在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中设置 `assetRoot`。patch 会替换该行的整个 `config`，因此除非 profile 挂载了 `workspace-dependencies`（Desktop 和 SDK 都要求 `DSH_PRIMARY_RUNTIME` 非空），还要设置 `pythonEnvironment: user`：

   ```yaml
   - id: skill-office
     config:
       assetRoot: /absolute/path/to/office-skills
       pythonEnvironment: user
   ```

2. 也可以在[项目或用户技能目录](../../../../packages/skill/skill-filesystem/README.zh.md)中放置名为 `office`、`office-docx`、`office-pptx` 或 `office-xlsx` 的技能；文件系统技能优先于同名内置技能。
3. 删除从 Desktop 资源、Python wheel 或准备好的主运行时载荷中复制或读取 `office-skills/` 的步骤。容器只复制 `primary-runtime/`，并让 `DSH_PRIMARY_RUNTIME` 继续指向它。
4. 确认：在新 Session 中加载 `office-docx`，其结果给出的基础目录位于技能包的 `assets/` 下、所配置的 `assetRoot` 下，或覆盖它的技能目录中。
