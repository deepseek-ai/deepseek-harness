/**
 * External compatibility API tests for retained string constructors.
 * Keep these direct calls confined to API compatibility tests, never business fixture helpers.
 */
import { describe, expect, it } from 'vitest'
import { AttachmentId, ImageVariantId } from '../packages/attachment/attachment/src/brand.ts'
import { BrowserUseProviderName } from '../packages/browser-use/browser-use/src/brand.ts'
import { RpcId } from '../packages/client/connection/src/rpc.ts'
import { CompactionId } from '../packages/compaction/compaction/src/brand.ts'
import { ComputerUseProviderName } from '../packages/computer-use/computer-use/src/brand.ts'
import { SessionId } from '../packages/core/session/src/types.ts'
import { OfficeKitGeneration, OfficeKitKey, OfficeSourceKey } from '../packages/document/office-kit/src/identity.ts'
import { WebhookDeliveryId, WebhookRuleId, WebhookSourceId } from '../packages/experimental/webhook/src/brand.ts'
import {
  ApprovalRequestId as CordisApprovalRequestId,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
} from '../packages/extensions/cordis-host-runner/src/index.ts'
import { FsTargetKey, FsVersion } from '../packages/fs/fs/src/types.ts'
import { GoalId } from '../packages/goal/goal/src/runtime.ts'
import { CommandDefinitionId, CommandId } from '../packages/interaction/commands/src/brand.ts'
import { ApprovalRequestId as UserApprovalRequestId } from '../packages/interaction/user-approval/src/types.ts'
import { JobId } from '../packages/jobs/jobs/src/brand.ts'
import { DeepSeekFileId, DeepSeekFileScope } from '../packages/llm/llm-deepseek/src/file-id.ts'
import { RetryId } from '../packages/llm/llm-retry/src/brand.ts'
import {
  LlmAttemptId,
  MessageId,
  ProviderRequestId,
  ReasoningEffortId,
  ToolCallId,
} from '../packages/llm/llm/src/brand.ts'
import { LspProviderId } from '../packages/lsp/lsp/src/brand.ts'
import { ScheduleId } from '../packages/schedule/schedule/src/domain.ts'
import { SessionSearchCursor } from '../packages/session-query/session-query/src/cursor.ts'
import { SessionPersistenceRevision } from '../packages/session/session-persistence/src/revision.ts'
import { SessionTitleProviderId } from '../packages/session/session-title/src/index.ts'
import { SpillLocator } from '../packages/spill/spill/src/types.ts'
import { SubagentRunId } from '../packages/subagent/subagent/src/types.ts'
import { TeamId, TeamMessageId, TeamTaskId } from '../packages/team/agent-team/src/types.ts'
import { TerminalSessionId } from '../packages/terminal/terminal/src/index.ts'
import { WorkflowRunId } from '../packages/workflow/workflow/src/types.ts'
import { WorkspaceId } from '../packages/workspace/workspace/src/index.ts'

describe('External compatibility API: retained string constructors', () => {
  it.each<[string, (value: string) => string]>([
    ['attachment.AttachmentId', AttachmentId],
    ['attachment.ImageVariantId', ImageVariantId],
    ['browser-use.BrowserUseProviderName', BrowserUseProviderName],
    ['client-connection.RpcId', RpcId],
    ['compaction.CompactionId', CompactionId],
    ['computer-use.ComputerUseProviderName', ComputerUseProviderName],
    ['session.SessionId', SessionId],
    ['office-kit.OfficeKitGeneration', OfficeKitGeneration],
    ['office-kit.OfficeKitKey', OfficeKitKey],
    ['office-kit.OfficeSourceKey', OfficeSourceKey],
    ['webhook.WebhookDeliveryId', WebhookDeliveryId],
    ['webhook.WebhookRuleId', WebhookRuleId],
    ['webhook.WebhookSourceId', WebhookSourceId],
    ['cordis-host-runner.ApprovalRequestId', CordisApprovalRequestId],
    ['cordis-host-runner.CordisDynamicPackageId', CordisDynamicPackageId],
    ['cordis-host-runner.CordisDynamicPluginId', CordisDynamicPluginId],
    ['cordis-host-runner.CordisDynamicPluginRunId', CordisDynamicPluginRunId],
    ['fs.FsTargetKey', FsTargetKey],
    ['fs.FsVersion', FsVersion],
    ['goal.GoalId', GoalId],
    ['commands.CommandDefinitionId', CommandDefinitionId],
    ['commands.CommandId', CommandId],
    ['user-approval.ApprovalRequestId', UserApprovalRequestId],
    ['jobs.JobId', JobId],
    ['llm-deepseek.DeepSeekFileId', DeepSeekFileId],
    ['llm-deepseek.DeepSeekFileScope', DeepSeekFileScope],
    ['llm-retry.RetryId', RetryId],
    ['llm.LlmAttemptId', LlmAttemptId],
    ['llm.MessageId', MessageId],
    ['llm.ProviderRequestId', ProviderRequestId],
    ['llm.ReasoningEffortId', ReasoningEffortId],
    ['llm.ToolCallId', ToolCallId],
    ['lsp.LspProviderId', LspProviderId],
    ['schedule.ScheduleId', ScheduleId],
    ['session-query.SessionSearchCursor', SessionSearchCursor],
    ['session-persistence.SessionPersistenceRevision', SessionPersistenceRevision],
    ['session-title.SessionTitleProviderId', SessionTitleProviderId],
    ['spill.SpillLocator', SpillLocator],
    ['subagent.SubagentRunId', SubagentRunId],
    ['agent-team.TeamId', TeamId],
    ['agent-team.TeamMessageId', TeamMessageId],
    ['agent-team.TeamTaskId', TeamTaskId],
    ['terminal.TerminalSessionId', TerminalSessionId],
    ['workflow.WorkflowRunId', WorkflowRunId],
    ['workspace.WorkspaceId', WorkspaceId],
  ])('%s preserves the supplied string without validation or generation', (_name, constructor) => {
    for (const value of ['', 'external-id:42', ' \t untrimmed \r\n', '标识/🔑:\u0000value']) {
      expect(constructor(value)).toBe(value)
    }
  })
})
