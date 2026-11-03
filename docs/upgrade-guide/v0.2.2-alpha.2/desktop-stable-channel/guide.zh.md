---
kind: upgrade-guide
description: "桌面正式更新渠道由 latest 更名为 stable。"
---

# 桌面正式渠道名称

[English](guide.md) | 中文

## 变更

桌面安装包、更新清单及渠道配置使用 `stable`，不再使用 `latest`。`nightly` 渠道不变。旧渠道值会被拒绝，不提供别名。网站名为 `dsh-latest-*` 的固定下载文件保持不变。

## 迁移

1. 在打包工作流中选择 `stable`，或在构建正式渠道包时设置 `DSH_DESKTOP_UPDATE_CHANNEL=stable`。使用不含预发布后缀的稳定版本号。
2. 如果本地桌面配置文件包含 `updates.channel: "latest"`，将该值改为 `"stable"` 并重启桌面应用。省略该字段时使用安装包默认值。
3. 使用更新后的工具发布：在各架构的清单目录内，Windows 写入 `stable.yml`，macOS 写入 `stable-mac.yml`；正式渠道二进制位于 `stable/` 下。在正式发布前，通过测试部署核对选定渠道和请求的清单。仍请求 `latest` 清单的旧包不会自动迁移。
