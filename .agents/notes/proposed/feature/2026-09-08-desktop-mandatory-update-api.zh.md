# Agent Note: Desktop 强制更新接口

Status: proposed

[English](2026-09-08-desktop-mandatory-update-api.md) | 中文

## 问题

Desktop 在业务 server 为本地进程、用户尚未登录时也需要获取强制更新判定。移动端普通更新响应不定义 Desktop 产物安装。后端与 Desktop 需要一份自包含协议，明确成功、阻断和错误语义，与 updater 的产物选择分开。

## 提案

使用未登录可访问的策略接口。本文负责 Desktop 请求响应字段，[一期更新提案](2026-09-08-desktop-update-policy-and-installation.zh.md)负责客户端调度、界面、发布顺序与安装。后端正在接入；API 地址与网关细节是部署输入，不表示服务已经可用。理解本协议不依赖旁边的仓库或本机文档。

### 接口与访问

[客户端决策](../../implemented/feature/2026-09-11-desktop-mandatory-update-client.zh.md)负责已实现的轮询和阻塞界面。本接口提案仍负责后端部署与真实联调；本地 fixture（测试前置数据）不能认证服务。

```http
GET /api/v0/check_client_update
```

查询接口本身必须返回完整强制响应，不能依赖拦截其他业务接口。保持 Android 与 iOS 既有行为，不要求旧移动端补传 Desktop 新字段。Desktop 仅接收强制策略，不接收普通更新提示、安装包元数据、updater 目标版本、设备 ID、安装实例 ID 或按实例灰度分配。

### 请求

```http
GET /api/v0/check_client_update?scenario=launch
x-client-platform: desktop-win
x-client-version: 0.1.3-rc.2
x-client-bundle-id:
x-client-locale: zh_CN
x-client-timezone-offset: 28800
x-client-arch: x64
x-client-update-channel: nightly
x-client-bundled-dsh-version: 0.1.3-rc.2
```

以上 header 在每次 Desktop 请求中均为必填；必填 header 的取值可以为空，`x-client-bundle-id` 即如此。描述已安装软件的值来自应用与发布元数据，不来自可编辑 UI 字段。

| Header | 含义与取值 |
|---|---|
| `x-client-platform` | `desktop-win` 或 `desktop-mac` |
| `x-client-version` | 共享的客户端构建版本，在打包时内联为 `DSH_CLIENT_VERSION`；完整 SemVer，保留预发布标识，一期等于内置 dsh 版本 |
| `x-client-bundle-id` | Platform 用该字段标识 Chat 应用；该字段对 Harness 不适用，因此 Desktop 发送空值 |
| `x-client-locale` | `zh_CN` 或 `en_US`，取自当前 UI 语言的主语言子标签；选择本地化内容，不代表区域 |
| `x-client-timezone-offset` | 与 UTC 的整秒偏移，东为正，每次请求时从壳采样 |
| `x-client-arch` | Windows 为 `x64`；macOS 为 `x64` 或 `arm64` |
| `x-client-update-channel` | 一期固定 `nightly`，独立于版本后缀 |
| `x-client-bundled-dsh-version` | 发布元数据中的完整内置 dsh 版本 |

| Query | 客户端行为 | 后端一期行为 |
|---|---|---|
| `scenario` | 携带查询来源；`launch` 是启动示例 | 忽略；桌面最终枚举不阻塞接入 |
| `region` | 可选；仅在有可信区域信息时携带 | 忽略；不从 UI 语言推断 |

两个 query 都不参与一期策略匹配或参数校验。其他客户端条件相同时，改变或省略任一 query 不得改变判定。生命周期触发点与 query 枚举不必一一对应；后端启用使用前再约定枚举与统计。

### 无需强制更新

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": null
  }
}
```

这表示当前客户端无需强制更新，不表示已安装版本最新。针对当前客户端条件的新鲜有效响应可以清除已有阻断。Desktop 不消费此响应中的移动端普通更新载荷。

### 需要强制更新

```json
{
  "code": 40005,
  "msg": "Client version too low",
  "data": {
    "show_content": {
      "title": "请更新 DeepSeek Harness",
      "detail": "当前版本已停止支持，请下载并安装新版本。"
    },
    "desktop_app_link": "https://example.com/harness/download"
  }
}
```

示例 URL 是占位符，不是获准部署的目标地址。Desktop 使用拍平的 `data` 字段，不包裹 `alt_app` 或 `biz_data`。尚无已分发 Desktop，因此不需要兼容较早嵌套提案的解析器。移动端 `alt_app`、Android 链接与 iOS 应用标识保持既有格式。

| 字段 | 要求 |
|---|---|
| `code` | `40005` 是响应体错误码，不是 HTTP 状态 |
| `msg` | 仅用于诊断，不作弹窗文案 |
| `data.show_content.title` | 必填，本地化纯文本标题 |
| `data.show_content.detail` | 必填，本地化纯文本正文 |
| `data.desktop_app_link` | 必填，匹配产品、平台、架构与通道的 HTTPS 页面，必须符合客户端允许列表 |

一期不增加 `mode`、`force_update`、`show_key`、`target_version`、按钮文案或 updater 元数据。`40005` 决定必须升级，实际版本与安装包由 updater 元数据决定。客户端不依据本接口另做强制目标版本校验。客户端状态决定本地化操作，每次下载仍需用户操作。接入应用内 updater 后，页面仍作为兜底。HTTP 状态映射按网关联调确认；网关必须保留 JSON 错误体，不能替换为通用文本或 HTML。

### 错误与策略匹配

缺少必填 header、非法 SemVer 或不支持的平台／架构／通道组合返回明确参数错误，不能伪装为无强制成功或强制策略。优先沿用 `biz_code = 1` 表示缺少版本、`biz_code = 2` 表示版本非法的既有业务含义；最终错误码分配由后端负责。服务异常不得伪装成成功，因为成功可能解除已有阻断。

按平台、架构、Desktop 版本、内置 dsh 版本与通道匹配，由服务端维护版本范围和优先级。使用完整 SemVer，不按字符串排序或截断预发布部分。一期两个版本相等、通道固定 Nightly，独立修订与通道切换延后。不得要求降级，也不得仅因客户端曾查询或展示过就停止返回 `40005`。

### 策略发布与当前判定

每条生效策略需要可确定的匹配条件、本地化标题正文和有效目标页面。服务端每次查询均判定当前客户端条件。这些是服务端配置要求，不增加响应字段，也不是安装包撤回机制。

- 启用策略前发布并验证能解除强制要求的更高版本，确保匹配的页面与平台安装包可用。
- 对启用应用内强制更新的客户端，先向其 updater feed 发布能解除要求的版本，再启用强制要求。发布负责人协调该顺序；API 不提供独立安装目标、产物适用性响应或普通更新灰度。
- 链接匹配产品、平台、架构与通道；缺少文案或获准 HTTPS 目标时拒绝启用策略。
- 当前客户端不再命中时返回无强制成功响应，包括升级后；仍命中时持续返回强制策略。

问题版本通过发布更高修复版本并更新 updater 元数据处理。不向本接口增加作废版本清单、安装前产物撤回查询或目标版本校验。新鲜的无强制响应可以解除 UI 阻断，但不选择、替换或作废 updater 安装包。产物哈希／签名校验仍独立于强制判定执行。

### 容量与缓存

容量与限流需覆盖持续未登录请求，并考虑客户端合并与失败退避。策略触达不依赖聊天请求或 SSE（Server-Sent Events）。在线触达延迟受轮询和网络影响，离线客户端无法立即获知新策略。建议 `Cache-Control: no-store`。网关不得仅按 URL 跨客户端版本、平台、架构或通道共用响应；后续缓存必须定义所有策略与文案维度和判定新鲜度。

## 考虑过的替代方案

**依赖远程业务拦截。** 本地 dsh 请求不一定到达远程网关，需要独立的未登录查询。

**Desktop 复用移动端嵌套载荷。** 后端约定拍平 Desktop 字段。按平台保留移动端兼容，不让新 Desktop 支持从未分发的嵌套变体。

**增加安装身份与普通更新元数据。** 初期策略不需要按安装实例灰度或第二个安装器 feed。产物发现继续由 updater 负责。

## 验收标准

| 用例 | 预期结果 |
|---|---|
| 未登录 Desktop | 无需业务登录即可查询 |
| Windows x64、macOS x64 和 arm64 | 正确的平台策略与页面 |
| 不命中策略 | `code = 0`、`biz_code = 0`、`biz_data = null` |
| 命中策略 | 顶层 `40005`，文案与页面直接位于 `data` 下 |
| 改变或省略 query 参数 | 其他条件相同时判定一致 |
| 相等的 Desktop/dsh 预发布版本、固定 Nightly | 完整 SemVer 匹配，不要求降级或切换通道 |
| 客户端不再命中，包括升级后 | 返回无强制成功，不作废 updater 产物 |
| 可解除要求的发布、页面或适用 feed 不可用 | 拒绝启用策略 |
| 必填字段非法或服务失败 | 明确错误，不伪装为无强制成功 |
| 不同客户端条件连续请求 | 不跨客户端串用缓存 |
| 现有移动端请求 | 保持既有要求与响应结构 |

## 风险

后端需提供测试／生产地址、未登录网关访问、最终 HTTP／错误码映射、限流、真实页面、允许域名、兜底语言和策略配置负责人。发布负责人需逐平台协调 updater 版本可用与强制策略启用。这些输入仍待提供，不得用开发者凭据或猜测 URL 填充。
