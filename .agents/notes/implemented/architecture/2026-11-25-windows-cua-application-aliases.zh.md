# Agent Note: 使用显式路径别名的 Windows 应用授权

Status: implemented

[English](2026-11-25-windows-cua-application-aliases.md) | 中文

## 问题

Windows 启动器与拥有可见窗口的应用可能使用不同的可执行文件路径，且不提供共同的 AUMID。把每一对此类程序都视为无关应用，会让常用产品重复请求授权。为任意应用推断这种关系，又可能合并用户希望分别授权的程序。

## 决策

Windows 依次使用窗口的显式 AUMID、打包应用的进程 AUMID 和可执行文件路径作为观察到的应用标识。一份小型维护名单仅在没有 AUMID 或调用方选择可执行文件路径时，将特定启动器与运行文件路径映射到已知产品 ID。[包参考文档](../../../../packages/experimental/cua-windows/README.zh.md#known-application-aliases)维护支持的布局。其他路径保留原有身份。显式路径选择保留其启动目标，不枚举 AppsFolder。

窗口首次接纳时检查应用关联。已接纳的 HWND 在有效期间保留该关联。helper 不保留目标 PID 或进程启动时间，也不在每次操作前重复检查应用身份。本实现通过 Windows 句柄有效性判断所选窗口的生命周期。

授权继续对 `windows-aumid\0` 与所选 ID 的拼接结果取哈希。明确保存的授权与撤销使用 [profile 授权存储](2026-10-19-cua-profile-consent-storage.zh.md)。此决策仅适用于 Windows：[macOS bundle-ID 授权](2026-10-25-cua-bundle-id-consent.zh.md)与[共享应用授权执行](2026-09-26-cua-application-consent.zh.md)继续各自负责原有范围。

飞书条目的依据是对已安装快捷方式、启动器和运行文件的检查。GitHub Desktop 在[应用代码](https://github.com/desktop/desktop/blob/development/app/src/main-process/main.ts)中声明其 ID；[Squirrel 启动器](https://github.com/Squirrel/Squirrel.Windows/blob/develop/src/StubExecutable/StubExecutable.cpp)从版本目录启动同名可执行文件。这些观察支持各自的名单条目，不构成适用于所有 Squirrel 应用的规则。

## 考虑过的替代方案

**通过私有 Shell 接口解析全部桌面应用。** 未公开的解析器为普通应用发现增加系统兼容性和失败依赖。显式名单将推断限制在有具体证据的布局内。

**按发布者、安装目录或进程祖先归组。** 同一个发布者或目录可以包含独立应用；启动另一个进程不代表已同意访问它。名单指定单个可执行文件，不包含共享更新宿主及其他辅助程序。

**保留 PID 和进程启动元数据并反复验证归属。** 这些检查为操作已接纳 HWND 引入另一套应用生命周期模型和额外的进程查询。本实现采用 Windows 句柄有效性。

**只使用未经修改的路径身份。** 这能保留最小的应用发现实现，但会让名单中产品的启动器和带版本的运行文件重复请求授权。

## 后果

名单提供产品归组，不验证发布者。放置在匹配布局中的程序可以共享该产品的授权。匹配名单布局的版本和副本有意共享授权；未列出的启动器与运行文件仍可能需要分别授权。已有路径授权不会自动升级为共享产品 ID，macOS 行为也不改变。

每条名单记录都需要应用 ID 与可执行文件布局的证据、排除相邻无关路径的测试，以及启动器选择与窗口发现指向同一应用的验证。通用目录规则或新增推断来源需要单独决策；扩充此名单不代表批准这两类变更。
