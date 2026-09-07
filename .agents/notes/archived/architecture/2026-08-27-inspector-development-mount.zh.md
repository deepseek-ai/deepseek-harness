# Agent Note: Inspector 开发挂载

Status: implemented
Archived: 2026-09-04

[English](2026-08-27-inspector-development-mount.md) | 中文

## Problem

`@deepseek-ai/dsh-experimental-inspector` 是任何已发布 dsh 安装都不携带的 private 包，但开发启动需要按需把它挂进随货 Web 组合。随货 bundle patch 里的一行表达不了这件事：`verify-cordis-config` 要求 bundle patch 中每个具名行都能从该 bundle 自己的 `dependencies` 解析——disabled 行也不豁免——而已发布的 manifest 不得依赖未发布的包。

## Decision

inspector 包自有两份开发 overlay。`packages/experimental/inspector/cordis.source.patch.yml` 为 `pnpm run demo:inspector` 背后的 tsx 源码启动插入 `./src/index.ts`；`packages/experimental/inspector/cordis.patch.yml` 为执行过 `pnpm run build` 后的 `node apps/cli/lib/bin.js web --patch ./packages/experimental/inspector/cordis.patch.yml` 插入 `./lib/index.js`。

两个相对 entry 都通过 Loader 常规的所属 tree `baseUrl` 从各自 overlay 文件目录解析。源码启动因此直接读取 TypeScript，built 启动读取包产物；两条路径都不读取或修改 profile 已安装插件状态。源码或 built entry 缺失时，Loader import 会响亮失败，不会跳过 Inspector。

## Consequences

已发布的包不携带 inspector 的任何痕迹：没有 manifest 条目、没有组合行、没有 launcher flag。挂载保持按次启动选择——不带 overlay 的同一服务永远不会加载该包——且启动组合的每一层都由 config 文件声明。源码快捷命令会自动指定对应 overlay；built 启动需显式指定 built overlay，并要求 `lib/` 产物为当前版本。

## Alternatives considered

- 随货 web-app patch 里放 `disabled: !!js` 行：依赖门禁与 npm 发布都会把 private 包逼进已发布 manifest。
- `--inspector` launcher flag 把包挂成额外 bundle 层：launcher 既不拥有 app flag 也不拥有插件包名。
- `dsh-web-app` 上加 optional `peerDependencies` 并由其 glue 插件动态 `ctx.loader.create`：向已发布 manifest 写入永不发布的名字，且挂载的行不在任何 config 层声明。
- 两种启动模式共用一份 bare-package overlay：源码解析可以使用 workspace 门面，但 built 解析会依赖与本次启动命令无关的持久 profile 安装状态。
