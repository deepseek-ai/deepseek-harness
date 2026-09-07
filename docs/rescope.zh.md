# Vendored 包改名

[English](rescope.md) | 中文

Cordis 框架及其基础库以源码形式 vendored 在 [`vendor/`](../vendor/README.md) 下，并以 `@deepseek-ai` scope 发布：每个 harness 包都把框架声明为 peer dependency，发布 harness 就会连带发布这一层，用上游名发布等于在 registry 上占用别人的名字。本页是名字映射表；决策与影响见 [改名 Agent Note](../.agents/notes/archived/process/2026-08-10-vendor-package-rescope.md)，上游 commit 见 [`vendor/README.md`](../vendor/README.md)。

## 名字映射

| 目录 | 上游名 | 发布名 | 上游版本 | 角色 |
|---|---|---|---|---|
| `vendor/cordis/` | `cordis` | `@deepseek-ai/cordis` | 4.0.0-rc.7 | 框架核心：`Context`、`Service`、`Fiber`、事件 |
| `vendor/cosmokit/` | `cosmokit` | `@deepseek-ai/cosmokit` | 1.8.1 | 框架与 Schemastery 共用的基础工具 |
| `vendor/schemastery/` | `schemastery` | `@deepseek-ai/schemastery` | 3.18.0 | 配置 schema（`Schema`），每个插件的 `Config` 都基于它 |
| `vendor/loader/` | `@cordisjs/plugin-loader` | `@deepseek-ai/cordis-plugin-loader` | 1.0.0-rc.5 | `cordis.yml` 装载、插件解析、repository 缓存 |
| `vendor/include/` | `@cordisjs/plugin-include` | `@deepseek-ai/cordis-plugin-include` | 1.0.4 | 配置包含与 patch 叠加 |
| `vendor/group/` | `@cordisjs/plugin-group` | `@deepseek-ai/cordis-plugin-group` | 1.0.0 | 嵌套插件分组 |
| `vendor/timer/` | `@cordisjs/plugin-timer` | `@deepseek-ai/cordis-plugin-timer` | 1.1.2 | `ctx` 上随 disposal 回收的定时器 |
| `vendor/hmr/` | `@cordisjs/plugin-hmr` | `@deepseek-ai/cordis-plugin-hmr` | 1.0.15 | 插件与配置的热替换 |
| `vendor/logger-console/` | `@cordisjs/plugin-logger-console` | `@deepseek-ai/cordis-plugin-logger-console` | 1.0.0 | 控制台日志导出 |

子路径导出保持原路径：`@cordisjs/plugin-loader/repository` 变成 `@deepseek-ai/cordis-plugin-loader/repository`。

## 改名不碰什么

- **目录名与上游源码版本。** `vendor/hmr/` 仍是 `vendor/hmr/`，清单表记录的是所钉住源码快照的上游版本，因此清单读作一份上游快照；而每个 vendored 包 `package.json` 自身的 `version` 字段是 harness 发布的清单版本，`pnpm run release:vendor` 会提升它，重新 sync 时会恢复成上游版本。
- **依赖 range。** 依赖条目只换键、不换范围：`"cordis": "^4.0.0-rc.7"` 变成 `"@deepseek-ai/cordis": "^4.0.0-rc.7"`；`linkWorkspacePackages` 靠这些保留下来的范围把它们解析到固定的 workspace。
- **Loader 的 `cordis:` 内建前缀。** `cordis:include`、`cordis:group` 是协议前缀，不是包名。
- **`cordis.yml` 配置文件家族**，包括 `*.cordis.yml`、`*.cordis.snapshot.yml`、`cordis.patch.yml`。
- **名字里带这个词的 harness 包**，例如 `@deepseek-ai/dsh-tool-cordis`。
- **上游运行时标识符**，例如 Schemastery 的 `Symbol.for('schemastery')` 及其 `vendor:` 元数据字段。
- **`docs/` 之外的散文。** `vendor/*/README.md`、各包 README 与 Agent Note 保留写作当时的名字；那里的裸 `cordis` 也可能是 Python SDK 的选项名或某个 agent-preset 的 id。`docs/` 之内，散文与所有 Markdown 围栏都跟着改。

## 你的代码要改什么

| 位置 | 改前 | 改后 |
|---|---|---|
| 模块 import | `import { Context } from 'cordis'` | `import { Context } from '@deepseek-ai/cordis'` |
| 类型事件声明合并 | `declare module 'cordis'` | `declare module '@deepseek-ai/cordis'` |
| `package.json` 依赖键 | `"@cordisjs/plugin-hmr": "^1.0.15"` | `"@deepseek-ai/cordis-plugin-hmr": "^1.0.15"` |
| `cordis.yml` 插件条目 | `name: '@cordisjs/plugin-include'` | `name: '@deepseek-ai/cordis-plugin-include'` |

## 施加、核验与回退

上面这份映射由 [`scripts/rescope-vendor.ts`](../scripts/rescope-vendor.ts) 承载并执行改名，任何引用都不靠手改：

```sh
pnpm run rescope-vendor            # report what would change
pnpm run rescope-vendor --apply    # rewrite every reference
pnpm run rescope-vendor:check      # assert the post-state; runs in the hygiene gate
pnpm run rescope-vendor --apply --reverse   # return to the upstream names
```

上游 sync 之后重跑它（[流程](../vendor/README.md)），并接上它打印的重生成：`pnpm install` 重生成 lockfile、`pnpm run gen-third-party-notices`、以及对它触及的双语对跑 `pnpm run verify-translation-pairing --write`。
