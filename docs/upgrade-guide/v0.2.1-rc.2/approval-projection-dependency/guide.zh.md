---
kind: upgrade-guide
description: "自定义 ApprovalService 组合必须提供 sessionProjections 并等待服务激活。"
---

# 审批服务要求 Projection 注册表

[English](guide.md) | 中文

## 变更

`ApprovalService` 要求 `sessionProjections`。它在激活时等待 Projection 注册，不再在注册表缺失或尚未就绪时读取事件日志。原先只挂载审批服务的自定义组合必须补上注册表。发布的配置已提供该服务。

审批结果、审计事件、策略默认值和同步业务方法保持原有行为。会话日志和检查点格式不变。私有注册句柄仅在进程内有效；检查点只保存策略覆盖值和轮次状态。

## 迁移

1. 在自定义 `cordis.yml` 中，先挂载 `@deepseek-ai/dsh-session-projection`，再挂载 `@deepseek-ai/dsh-user-approval`。不要向发布的配置重复添加注册表。
2. 在直接挂载服务的宿主中，使用 `ctx.plugin(ApprovalService)` 并等待激活完成，再使用 `ctx.approval`。不要用 `new ApprovalService(...)` 直接构造服务；这不会执行 `Service.init`。

   ```ts
   import { Context } from '@deepseek-ai/cordis'
   import SessionStore from '@deepseek-ai/dsh-session'
   import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
   import ApprovalService from '@deepseek-ai/dsh-user-approval'

   const ctx = new Context()
   await ctx.plugin(SessionStore)
   await ctx.plugin(SessionProjectionRegistry)
   await ctx.plugin(ApprovalService)
   ```

3. 由宿主和注册表完成会话恢复，再向同步读取方交付历史状态。遵循[注册表生命周期](../../../../packages/session/session-projection/README.zh.md)；不要在审批 getter 中加载历史，也不要在回放时触发运行时钩子。
4. 确认激活完成，原有审批测试仍产生相同的结果和审计记录。注册错误必须使激活失败，不能切换到全日志回退路径。
