# Agent Note: 供应链检查与 vendor 漂移验证

Status: proposed

[English](2026-06-11-supply-chain-and-vendor-drift.md) | 中文

## 问题

vendor manifest（元数据清单）（见[引入 vendor 的决策](../../archived/process/2026-06-11-vendor-cordis-as-source.md)）在提交时仅在*正向*强制执行（vendor 变更 ⇒ manifest 更新），但没有任何机制验证 manifest 的*声明*：即 vendor/ 确实等于上游指定 SHA 的内容加上所记录的修改。此外，少量真正的 NPM 依赖也没有安全公告监控或更新节奏。

## 提案

1. **Vendor 漂移检查**（夜间 CI）：以 manifest 中记录的 SHA 浅克隆上游仓库，复制对应的包源码，与 `vendor/*/src` 做 diff。除非 diff 与已记录的本地修改一致（每项修改以签入的 patch 文件保存——日志条目从行文描述变为可验证的产物），否则任务失败。
2. **依赖安全公告**：对 lockfile 运行 osv-scanner（或 `pnpm audit`），按计划定期执行，并在涉及 lockfile 变更的 PR（Pull Request）上触发。
3. **许可证清单**：一个脚本断言每个 vendor 包都携带其 LICENSE 文件，且 package.json 的 `license` 字段与 vendor/README.md 中的清单一致（我们混合了 vendor 的 MIT 与自有的 BSD-3）——作为 CI 步骤运行。
4. **Renovate**（或定时 agent（智能体）任务）以小 PR 的形式提议 NPM 依赖更新，这些 PR 走完整门禁套件；vendor 包不在其列（它们的更新遵循 manifest 同步流程，理想情况下是半自动化的 agent 工作流：拉取上游、重新应用 patch、运行门禁、以更新后的 manifest 表格开 PR）。

## 计划

第 3 项最简单，先做。第 1 项需要 CI 能通过网络访问上游仓库（私有仓库，需要 token），并将现有两项已记录的修改转换为 patch 文件。第 2 项和第 4 项是配置工作。

## 曾考虑的替代方案

- **用 `pnpm audit` 替代 osv-scanner**：两者都满足安全公告扫描的需求；具体选择推迟到实现阶段决定。
- **用定时 agent 任务替代 Renovate**：在提议小型更新 PR 并走完整门禁套件方面效果等价；vendor 包无论哪种方案都不在其列（它们的更新遵循 manifest 同步流程）。

## 验收标准

- 许可证清单脚本在 CI 中运行，缺少 LICENSE 或 `license` 字段与 `vendor/README.md` 中的清单矛盾时失败。
- 夜间漂移任务从 manifest SHA 加签入的 patch 文件重建 `vendor/`，出现任何无法解释的 diff 时失败。
- 安全公告扫描按计划定期运行，并在涉及 lockfile 变更的 PR 上运行。

## 风险

上游仓库是私有镜像；CI 凭证与可用性是漂移检查的主要阻力。如果受阻，可改为本地定时 agent 任务而非 CI。
