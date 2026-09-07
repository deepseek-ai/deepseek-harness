# Agent Note: 用文件名标明 client 测试的编译面

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-face-named-client-test-files.md) | 中文

## 问题

`packages/client/*/tests/` 同时存放两个编译面的测试。多数覆盖某个 Client 包的浏览器半边，属于 `tsconfig.client.json`；少数覆盖拆分包的 Host 半边——载体的 node 半边 spec——只能在 `tsconfig.host.json` 里类型检查，因为触及 Host 源码的 Host 面 spec 需要那些文件所在的 Host 工程。

文件名不说明一个测试覆盖哪一面，两个聚合就无法按模式划分这个目录。host 聚合整体排除 `packages/client/**`，Client 聚合收下全部，于是 Host 面 spec 留在了 Client 程序里。它们随之需要 Client 聚合引用 `packages/client/connection/tsconfig.host.json`——一个 Client 配置进入拆分包的 Host 面，而 `constraints` 的工程引用规则拒绝这条边。

没有命名规则时另有两条出路，且都更差。在 host 聚合里用 `files` 把那四个文件凿回来，与同一个文件里的整体排除自相矛盾，且每新增一个 Host 面 spec 就要加一条。放行这条跨面引用则削弱了那条把两套 `Context` 合并隔开的规则。

## 决策

`packages/client` 下的测试文件在文件名里说明自己覆盖哪一面：

| 后缀 | 面 | 数量 |
|---|---|---|
| `*.client.spec.ts` / `*.client.spec.tsx` | Client | 232 |
| `*.client.ts` / `*.client.tsx`（共用辅助文件、fixture） | Client | 5 |
| `*.host.spec.ts` | Host | 4 |

两组后缀互斥——谁都不是对方的后缀——因此每个聚合各保留一条宽的测试 glob，并排除对面：

- `tsconfig.client.json` include `packages/client/*/tests/**/*.{ts,tsx}`，exclude `packages/client/*/tests/**/*.host.spec.ts`。
- `tsconfig.host.json` 经其仓库级 `packages/*/*/tests/**/*.ts` 到达同一目录，exclude `packages/client/*/src/**` 以及四条 `*.client.*` 模式。

这建立在 `exclude` 过滤 `include` 结果之上：两者同时命中时，文件留在程序外。没有文件被两个聚合同时点名，两个聚合都不需要 `files` 条目或跨面工程引用。`verify-md-links` 与 `constraints` 的工程引用规则原样通过，载体不需要任何例外。

`packages/client` 下新增的测试必须带面名后缀。不带后缀的文件会被 host 聚合的包级 glob 命中，并静默地把 Client 源码拖进 Host 程序。

## 本次改名清单

- 232 个 Client 面 spec，从 `*.spec.{ts,tsx}` 改为 `*.client.spec.{ts,tsx}`。
- 5 个 Client 面辅助文件，从 `*.{ts,tsx}` 改为 `*.client.{ts,tsx}`：`connection/tests/fake-api`、`runtime/tests/fake-api`、`runtime/tests/event-script`、`ui-conversation/tests/chat-snapshot-fixture`、`ui-tool/tests/tool-details-render`。
- `packages/client/connection/tests/` 下 4 个 Host 面 spec，从 `*.spec.ts` 改为 `*.host.spec.ts`：`api-request-trust`、`http-bridge`、`node-half`、`websocket-downlink`。
- 2 个 snapshot 文件，跟随各自 spec 改名，内容未变。

`scripts/rescope-vendor.ts` 的精确编辑表点名了其中三个 spec，那些路径随之移动。

## 考虑过的替代方案

**只给 Host 面文件加 `*.host.spec.ts` 后缀，Client 侧不动。** 第一次尝试就是这样，而它行不通：`.host.spec.ts` 同样以 `.spec.ts` 结尾，于是 host 聚合对 `*.spec.ts` 的排除把它一并吞掉，`include` 也赢不回来。让两条模式互不相交，靠的正是两面都命名。

**把 Host 面文件命名为 `*.host-spec.ts`，脱离 `.spec.ts` 惯例。** 不动 Client 侧即与 `*.spec.ts` 不相交，但为了一个配置细节离开了仓库的测试命名惯例和 vitest 的发现模式。

**把 Host 面 spec 移到 `tests/host/` 子目录，按路径划分。** 用 glob 同样可行，但它把一个包的测试拆到两个目录，浏览 `tests/` 的读者不再一眼看到它们在一起。

**保留对 `packages/client/**` 的排除，用 `files` 把 Host 面 spec 凿回来。** `files` 不受 `exclude` 过滤，所以确实能拿到它们——代价是同一个文件一边断言该目录属于另一个聚合、一边列出这条断言的例外，且每个 Host 面 spec 都要加一条。

## 后果

这条规则的成本是每个 client 测试文件名多一个后缀，买到的是一次机械划分：一个聚合的成员资格由文件名推出，而不是由一份清单决定。`constraints` 里那条禁止跨面引用的规则保持全部强度——没有包获得豁免。

Host 程序现在在 `packages/client` 下看到 11 个文件（4 个 Host 面 spec，以及经工程引用解析到的载体 Host 面声明），而在排除按模式、文件名却不按模式的状态下漏进来的是 60 个。

vitest 经 `**/*.spec.{ts,tsx}` 仍能发现每个改名后的文件，因此测试配置没有变化；完整 client 套件跑 235 个文件、3181 个用例。

这条规则留下的失败模式是新增一个不带后缀的测试：它会在 Host 程序里针对 Client 源码通过类型检查，而不是显式报错。
