---
kind: upgrade-guide
description: "Desktop 升级会将无版本的 settings.json 迁移至版本 1，在未解锁前隐藏“更新渠道”并将无版本 nightly 偏好重置为 stable，同时将打包与发布工作流改为默认 stable 与显式渠道复选框。"
---
# Desktop 更新渠道默认收敛到正式版并需显式解锁

[English](guide.md) | 中文

## 变更

此前 `<userData>/desktop/settings.json` 没有 schema `version` 字段，在**设置 → 通用设置**中直接展示**更新渠道**，且 `DSH_DESKTOP_UPDATE_CHANNEL` 与打包工作流输入 `update_channel` 默认均为 `nightly`。升级后，客户端会将合法的无版本 `settings.json` 原地迁移为 `"version": "1"`，移除无版本的 `updates.channelUnlocked` 字段，并将无版本的 `"nightly"` 偏好重置为 `"stable"`。在未同时写入 `"version": "1"` 与 `updates.channelUnlocked: true` 前，Desktop 隐藏**更新渠道**并固定检查 `stable`，不受包内 `dshDesktopUpdateChannel` 影响。本地打包脚本与 `Package Desktop` 工作流现默认将 `DSH_DESKTOP_UPDATE_CHANNEL` 和 `update_channel` 设为 `stable`，`Publish Desktop · COS`（`desktop-publish.yml`）与 `Publish Desktop · Rollout & Website`（`desktop-rollout.yml`）要求显式传入布尔目标开关（`publish_stable`、`publish_nightly`、`rollout_stable`、`rollout_nightly`、`upload_website`）。受影响的是此前切换到开发版渠道的 Desktop 用户，以及触发 Desktop 打包或发布工作流的操作人员。

## 迁移

1. 如需在升级后的 Desktop 客户端继续使用开发版（`nightly`）更新渠道，打开**设置 → 通用设置**，连续点击五次**当前版本**，并在弹窗中确认**切换到开发版**。确认界面出现值为**开发版**的**更新渠道**，且 `<userData>/desktop/settings.json` 包含 `"version": "1"`、`"channel": "nightly"` 与 `"channelUnlocked": true`。
2. 若脚本化触发 `Package Desktop` 时依赖原默认 `nightly` 包内标记，请显式传入 `-f update_channel=nightly`（本地构建传入 `DSH_DESKTOP_UPDATE_CHANNEL=nightly`）。
3. 触发 `desktop-publish.yml` 与 `desktop-rollout.yml` 时显式传入目标开关（`-f publish_stable=true`、`-f publish_nightly=true`、`-f rollout_stable=true`、`-f rollout_nightly=true` 或 `-f upload_website=true`），并在批准部署前核对工作流审批摘要中的目标渠道。
