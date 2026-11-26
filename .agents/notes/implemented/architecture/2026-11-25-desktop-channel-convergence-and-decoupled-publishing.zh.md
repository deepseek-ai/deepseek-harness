# Agent Note: Desktop 更新渠道向 stable 收敛并与发布目标解耦

Status: implemented

[English](2026-11-25-desktop-channel-convergence-and-decoupled-publishing.md) | 中文

## 问题

早期 Desktop 构建默认内置 `nightly` 更新渠道，写入无版本的 `userData/desktop/settings.json` 时无法区分包内默认值与开发者的主动选择，在通用设置中直接暴露**更新渠道**，并将 CI 发布与放量绑定在构建时写入的单一渠道上。在此机制下，一旦向 `nightly` 投递激进实验包，包内默认或历史无版本偏好指向 `nightly` 的普通存量设备都会收到实验更新；而将同一份已签名版本同时投递到 `stable` 与 `nightly` 又必须重复打包、签名和公证两套产物。

要将普通用户收敛到 `stable` 并保留显式解锁后的 `nightly` 实验能力，需要将构建写入的包内渠道标记、发布目标渠道、客户端解锁状态，以及供更新网关区分未解锁旧请求与显式解锁请求的清单请求头拆分开来。

## 决策

保留 `stable` 与 `nightly` 双渠道。本地构建与 CI 打包工作流默认将 `DSH_DESKTOP_UPDATE_CHANNEL` 设为 `stable`。`Publish Desktop · COS` 与 `Publish Desktop · Rollout & Website` 通过独立的布尔复选框在同一份留存签名包上选择发布目标渠道（`stable`、`nightly` 或双渠道）及官网安装包上传，按渠道独立加锁与记录审计，并在生产环境按打包源码提交创建一次 `desktop-v<version>` tag。仅发布官网的放量运行直接校验并上传留存生产安装包与刷新缓存，不要求先完成渠道首次发布；`rollback-desktop-channel.ts` 依据 `DESKTOP_PUBLISH_ROUTE.channel` 而非 `manifest.source.channel` 重建回滚目标。

`userData/desktop/settings.json` 引入 `"version": "1"`。启动初始化在文件缺失时创建 `"version": "1"`，并将有效的无版本文件原地迁移为 `"version": "1"`，同时移除无版本的 `updates.channelUnlocked` 字段并将无版本的 `"nightly"` 渠道重置为 `"stable"`，绝不覆盖损坏的 JSON、无效结构、不支持的 `version` 值或无效字段。只要未同时具备 `"version": "1"` 与 `updates.channelUnlocked: true`，客户端即隐藏**更新渠道**（除非存在需恢复的配置错误），并将运行时有效渠道强制锁定为 `stable`，忽略包内 `dshDesktopUpdateChannel` 或未解锁字段。在桌面版**设置 → 通用设置**中连续点击五次**当前版本**会弹出风险确认对话框（初始焦点位于**取消**）；确认后写入 `"version": "1"`、`updates.channel: "nightly"` 与 `updates.channelUnlocked: true`，立即切换至 `nightly`，并在后续切回 `stable` 后继续显示**更新渠道**。

`DesktopUpdateProvider` 继承 `electron-updater` 的 `GenericProvider`，仅在 `.yml` 更新清单请求上附带非机密来源请求头（`x-dsh-config-version`、`x-client-update-channel`、`x-client-channel-source`、`x-client-version`、`x-client-bundled-dsh-version`、`x-client-platform`、`x-client-arch`，以及复用 `<userData>/.updaterId` 的 `x-client-device-id`），而 `.zip`、`.exe` 与 `.blockmap` 二进制下载不携带这些请求头。

## 渠道术语与清单路由

包内渠道标记（`dshDesktopUpdateChannel`）、发布目标渠道（`stable` / `nightly`）、客户端有效更新渠道（未解锁固定为 `stable`，解锁后按用户选择）与公开更新查询入口（`stable[-mac].yml` / `nightly[-mac].yml`）相互独立：包内标记为 `stable` 的产物可投递到 `nightly`，`stable` 渠道也可发布 RC 或 alpha 预发布版本。由于客户端禁用自动降级，已安装更高预发布版本的设备在 `stable` 尚未发布更高版本前保持当前版本，待更高版本发布后随常规升级回到 `stable` 渠道。

| 公开更新查询入口 | 请求条件 | 返回内容 |
|---|---|---|
| `stable[-mac].yml` | 任意请求 | 当前 `stable` 渠道源元数据 |
| `nightly[-mac].yml` | 缺少 `x-dsh-config-version: 1` 或缺少 `x-client-channel-source: explicit` | 当前 `stable` 渠道源元数据 |
| `nightly[-mac].yml` | 同时携带 `x-dsh-config-version: 1` 与 `x-client-channel-source: explicit` | 当前 `nightly` 渠道源元数据 |

未满足解锁条件的 `nightly[-mac].yml` 请求直接返回同平台持续更新的当前 `stable` 源元数据，不另行维护冻结的第三份基线 YAML；`stable` 的发布、灰度放量与回滚会同步作用于 `stable[-mac].yml` 与未解锁的 `nightly[-mac].yml` 请求，网关与 CDN 缓存须隔离锁定与已解锁两类响应。

## 后续推进项

- **外部更新网关分流配置（#9204）**：在停止向 `nightly` 同步投递稳妥版本前，由网关或动态更新服务对 `/dsh-desk/feeds/<target>/<feed>.yml` 按上表规则启用请求头分流；客户端启动、迁移与渠道切换不依赖网关切换时机。
- **收紧官网安装包的包内渠道检查（#9204）**：在留存的 `nightly` 标记包逐步退役期间，`desktop-website-installer.ts` 允许任一 `manifest.source.channel` 上传官网，后续收紧为仅允许 `manifest.source.channel === 'stable'`。
- **登录账号维度灰度请求头（#9204）**：向清单请求补充已登录账号标识请求头的工作留待动态更新分发后端消费该字段时一并接入。

## 考虑过的替代方案

**新增第三个 `alpha` 更新渠道。** 第三渠道会使 CI 复选框、清单文件、二进制前缀与用户界面选项成倍膨胀，却无法解决无版本存量设备的默认归属问题；保留 `stable`（承载常规版本与 RC）和 `nightly`（连点五次确认解锁）双渠道即可覆盖两类发布流。

**为迁移文件与新建文件分别定义 `"1"` 和 `"2"` 两个配置版本号。** 无版本的 `nightly` 偏好在启动迁移时重置为 `stable` 后，迁移文件与新建未解锁文件的运行时语义完全一致（均为 `version: "1"`，在 `channelUnlocked: true` 前锁定 `stable`），额外拆出第二个版本号只会增加无行为差异的分支。

**按目标渠道分别构建签名安装包。** 仅为改写 `dshDesktopUpdateChannel` 而对同一源码提交重复执行构建、macOS 公证与 Windows EV 签名会使构建成本翻倍，也无法直接将已验收产物晋升投递到另一渠道；解耦发布目标渠道与包内标记可消除重复构建。

**向所有 updater HTTP 请求附加来源请求头。** 若将自定义请求头写入全局 `updater.requestHeaders`，COS/CDN 上的 `.zip`、`.exe` 与 `.blockmap` 分片下载也会携带这些头，可能破坏二进制缓存命中或触发跨域头拒绝；在 `DesktopUpdateProvider.httpRequest` 内仅对 `.yml` 请求加头可保持二进制分发不变。

**无可用更新时返回 HTTP `204 No Content`。** `electron-updater` 6.8.9 的 `GenericProvider` 会无条件解析 `.yml` 响应体，将空的 `204` 响应视为无效更新元数据报错；无更新时仍应返回版本号小于或等于客户端当前版本的合法 YAML。

## 结果

- 普通安装与完成迁移的存量设备默认固定检查 `stable` 且不展示**更新渠道**，仅在用户对**当前版本**完成五次点击风险确认或出现需恢复的配置错误时显示。
- 存量设备随当前渠道出现更高版本后分批升级并迁移至 `"version": "1"`，无需启用自动降级；`DesktopSettingsFile.initialize()` 长期保留无版本迁移逻辑以覆盖跳过中间过渡版本的设备。
- 单次签名与公证产物可独立或同时投递至 `stable`、`nightly` 与官网固定下载地址；即使 `manifest.source.channel` 与投递渠道不同，频道回滚仍能按目标渠道准确恢复。
- 每次 `.yml` 检查均携带显式版本化来源标识（解锁后为 `x-dsh-config-version: 1` 与 `x-client-channel-source: explicit`），使外部网关可在不影响二进制下载缓存的前提下将 `nightly` 实验包与未解锁的 `nightly[-mac].yml` 请求隔离。
- `userData/desktop/settings.json` 遇到不支持的 `version` 值时显式报错暂停更新，绝不静默覆盖更高版本或已损坏的配置文件。
