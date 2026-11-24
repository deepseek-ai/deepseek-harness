/** Render Windows packaging inputs and resolved build identity without loading machine configuration. */
import { appendFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function text(value) {
  return value.replace(/[&<>"'|`\r\n\\*_\[\]()!~:]/gu, character => `&#${character.charCodeAt(0)};`)
}

/**
 * Summarize allowlisted workflow inputs separately from resolved checkout and version values.
 * @param {NodeJS.ProcessEnv} environment Workflow inputs and GitHub run identity.
 * @returns {string} Markdown parameter tables; no signature or publication success claim.
 */
export function windowsPackagingSummary(environment) {
  const row = (label, value, fallback = '未提供') => `| ${label} | ${value ? `<code>${text(value)}</code>` : fallback} |`
  return [
    '## Windows 打包参数', '',
    '以下记录输入参数与已解析结果，不代表构建、签名或发布成功；执行结果以各步骤状态为准。', '',
    '### 输入参数', '', '| 项目 | 选择值 |', '| --- | --- |',
    row('源码 ref', environment.PACKAGE_SOURCE_REF),
    row('环境', environment.DSH_PACKAGING_PRESET),
    row('升级通道', environment.DSH_DESKTOP_UPDATE_CHANNEL),
    row('版本模式', environment.PACKAGE_INPUT_VERSION_MODE),
    row('手动版本号', environment.PACKAGE_BUILD_VERSION, '未填写'),
    row('签名方式（请求）', environment.PACKAGE_SIGNING),
    row('安装器压缩等级', environment.PACKAGE_WINDOWS_COMPRESSION_LEVEL),
    row('测试 release ID（输入）', environment.PACKAGE_TEST_RELEASE_ID, '使用机器默认值（本摘要不读取）'),
    row('缓存命名空间', environment.PACKAGE_CACHE_NAMESPACE, '共享缓存'), '',
    '### 执行信息', '', '| 项目 | 已知值 |', '| --- | --- |',
    row('平台', 'win-x64'),
    row('工作流 ref', environment.GITHUB_WORKFLOW_REF),
    row('工作流 SHA', environment.GITHUB_WORKFLOW_SHA),
    row('检出源码 SHA', environment.PACKAGE_SOURCE_SHA, '尚未取得'),
    row('解析后的版本号', environment.PACKAGE_VERSION, '尚未解析成功'),
    row('Runner', environment.RUNNER_NAME),
    row('运行 ID', environment.GITHUB_RUN_ID),
    row('尝试次数', environment.GITHUB_RUN_ATTEMPT), '',
  ].join('\n')
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.GITHUB_STEP_SUMMARY) throw new Error('Windows packaging summary requires GITHUB_STEP_SUMMARY')
  await appendFile(process.env.GITHUB_STEP_SUMMARY, windowsPackagingSummary(process.env))
}
