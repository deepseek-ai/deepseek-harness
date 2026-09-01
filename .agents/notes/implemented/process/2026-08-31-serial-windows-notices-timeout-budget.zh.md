# Agent Note：serial-windows 的 notices 超时预算与 generator store 扫描成本

Status: implemented

[English](2026-08-31-serial-windows-notices-timeout-budget.md) | 中文

## Problem

`serial / windows (self-hosted standby)` master lane 一周内四次失败在 `test:coverage` gate（run 33333033178、33311481884、33352293522、33353113100），失败用例每次都相同：`scripts/gen-third-party-notices.spec.ts > THIRD_PARTY_NOTICES.md > matches what the generator produces from the current manifests`，报 `Error: Test timed out in 5000ms`。共享 Windows 主机上该用例实测 4149–8853 ms，超出 Vitest 默认的 5000 ms 单测预算。文件其余 26 个用例全部 0–3 ms 通过，两小时后的 passing run（33360033028）用同一份代码全绿。

该 lane 以 `DSH_COVERAGE_MAX_WORKERS=1` 串行跑完整的无分片 Windows gate 清单，`render()` 要从 workspace manifest 和已安装的 pnpm store 全量重生成 `THIRD_PARTY_NOTICES.md`，而主机被 32 个 runner 共享。冷路径的代价集中在 `workspaceLinkedManifest`：它对每个未缓存的外部依赖名重跑一遍 `loadWorkspaceManifests()`——glob 并读取、解析全部 workspace `package.json`——即 130 名 × 270 manifest ≈ 3.5 万次文件操作，另加每个名字一次 `.pnpm` store 扫描。叠加 v8 覆盖率插桩与共享主机 I/O 争抢后越过 5 秒默认值。

该 lane 还没有 `DSH_COVERAGE_TEST_TIMEOUT_MS`，而 pull-request 的 `windows-coverage` lane（[ci.yml](../../../../.github/workflows/ci.yml)）给的是 90000 ms——于是这条 serial 参考 lane 用全仓库最紧的预算跑同一份 coverage 清单。

## Decision

两处改动：

1. [scripts/gen-third-party-notices.ts](../../../../scripts/gen-third-party-notices.ts) 在 `render()` 里只加载一次 workspace manifest，把 map 沿 `collectNpmDeps` → `installedMetadata` → `installedManifest` → `workspaceLinkedManifest` 显式传递，不再按外部依赖名逐个重载。同一 checkout 下冷 `render()` 墙钟从约 893 ms 降到约 86 ms，输出逐字节一致（改动前后渲染结果 diff 验证）。

2. [ci-master.yml](../../../../.github/workflows/ci-master.yml) `serial-windows` 的 "Run complete unsharded Windows gate inventory serially" 步骤增加 `DSH_COVERAGE_TEST_TIMEOUT_MS: '90000'`，与 pull-request `windows-coverage` lane 对齐。这是把 [Windows 覆盖率 lane 的 hook 预算与 Lefthook 套件预算 note](../testing/2026-08-29-windows-lane-hook-and-lefthook-budget.zh.md) 定义的 per-test、expect.poll 与 hook 预算机制扩展到第二个 lane；该 note 记录了哪些 lane 设置此 env。`scripts/ci-workflow.spec.ts` 用 `toMatchObject` 断言钉住该 env；删掉 env 会让 spec 变红（已做负例验证）。

## Alternatives considered

- **只放宽 lane 预算** - 否决作为唯一修复：会掩盖所有运行 generator 的 lane 上的 O(名×manifest) 重载成本，包括 pre-commit hook 与独立 `--check` 路径。
- **给 `loadWorkspaceManifests()` 加模块级缓存** - 否决，改用显式传递：把「单次加载」契约留在调用点可见，避免在 `workspaceLinkedManifestCache` 之外再加一层隐藏缓存。

## Consequences

generator 每次 `render()` 调用只加载一次 manifest 来解析已安装元数据，并在调用开头清空按名字作键的 linked-manifest 缓存，使缓存不会活过它解析自的那份 map。serial-windows lane 与 pull-request coverage lane 一样按 90000 ms 单测预算跑 coverage 清单。`THIRD_PARTY_NOTICES.md` 字节不变；新鲜度 spec 仍把 `render()` 与已提交文档逐字节比较。
