# 实操手册：添加一个 vendored 包

[English](adding-a-vendored-package.md) | 中文

当 harness 需要引入另一个上游 Cordis 包（如 `@cordisjs/plugin-http`）时，应将其作为固定版本的源码 **vendor** 到 `vendor/` 下，而非作为 NPM 依赖添加。[vendor/README.md](../../vendor/README.md) 说明其原因并介绍如何*更新*已有的 vendored 包；本指南是添加**新** vendored 包的逐文件清单。（已对照现有 vendored 集合验证；如有偏差，请在此修正。）

## 1. 复制源码

```
vendor/<dir>/
  package.json     # from upstream; rescope the name, keep exports/type (publishable release member, no private flag)
  tsconfig.json    # extends ../../tsconfig.base.json (see configuration below)
  src/             # the upstream src/ verbatim
  README.md LICENSE # if upstream ships them
```

`tsconfig.json` 与其他 vendored 包保持一致：`rootDir: src`、`outDir: lib/types`、上游代码所需的严格性放宽项，以及对所导入的每个其他 vendored 包的 `references` 条目：

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src", "outDir": "lib/types",
    "noUncheckedIndexedAccess": false, "exactOptionalPropertyTypes": false,
    "noImplicitOverride": false, "noUnusedLocals": false, "noUnusedParameters": false
  },
  "include": ["src"],
  "references": [{ "path": "../cordis" }, { "path": "../cosmokit" }]
}
```

`package.json` 的不变式：改写 `name` 的 scope（[映射](../rescope.zh.md)），保留上游的 `exports`/`type`；声明元数据指向 `lib/types`；发布 `.d.ts` 与 `.d.ts.map` 声明输出；在 `peerDependencies` 中列出其 Cordis 依赖（与上游 manifest（元数据清单）一致）。vendored 包是可发布的 release member，因此不得设置 `private: true`，且必须设置 `publishConfig.access: public`；`version` 字段跟随 harness 发布序列（见 [vendor/README.md](../../vendor/README.md)）。传递性上游依赖本身也必须被 vendor 或已存在于仓库中——vendor 一个包往往意味着 vendor 其整条依赖树（如 `@cordisjs/plugin-http` 会拉入 `@cordisjs/fetch-file`）。

vendored TypeScript 源码中的本地相对导入/导出在复制后使用显式 `.ts` 后缀。这是仓库本地构建与上游的差异：`rewriteRelativeImportExtensions` 输出 `.js` 运行时导入，而声明文件保留显式 `.ts` 后缀，使 NodeNext/Node16 的 TypeScript 消费方能够解析。

## 2. 在根配置中注册

| 文件 | 修改内容 |
|---|---|
| `tsconfig.base.json` | 在 `paths` 中添加 `"<npm-name>": ["./vendor/<dir>/src"]` |
| `tsconfig.host.json` | 在 `references` 中添加 `{ "path": "./vendor/<dir>" }`（置于 `packages/*` 条目之前；vendored 代码只经 host 聚合进图） |
| `vendor/README.md` | 添加一行 manifest 表格行（dir、npm name、version、upstream repo、commit SHA）并记录所有本地修改 |
| `scripts/publint-all.ts` | 仅当该 vendored 包本身从此仓库发布时才需要（vendored 依赖通常不发布——跳过） |

以下由 glob 自动覆盖，无需手动编辑：根 `package.json` 的 workspaces（`vendor/*`）、`tsdown.config.ts`、`vitest.config.ts`、`.oxlintrc.json`。只有当构建配置与根默认值不同时（双 ESM/CJS 或多入口——参见 `vendor/schemastery` 和 `vendor/logger-console`），才需要单独的 `vendor/<dir>/tsdown.config.ts`；其入口应读取 `lib/types` 下输出的 JS。

## 3. 注意 manifest 守卫

`scripts/check-vendor-manifest.sh`（pre-commit 钩子）会在 `vendor/*/src` 下有暂存改动但 `vendor/README.md` 未一起暂存时失败。请将 manifest 更新与源码一起暂存，以通过提交检查。

## 4. 验证

```sh
pnpm install        # registers the workspace
pnpm run typecheck
pnpm run build && pnpm run constraints
```

请运行[测试政策](../testing.zh.md)所选择的行为检查。源码 `paths` 映射只在 `tsconfig.base.json` 存在一份，服务所有图。重要的隔离边界是 project-reference 图：vendored 源码必须通过其自身的 `vendor/<dir>/tsconfig.json` 被引用，而非被拉入某个聚合项目启用严格检查的 TypeScript 程序中（[布局](../development.zh.md#typescript-project-layout)）。
