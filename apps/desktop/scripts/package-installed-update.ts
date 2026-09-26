/** Operator-only signed packaging; default checks do not launch children, sign, install, or publish. */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { InstalledUpdateSigningHoldError, packageInstalledUpdate } from './installed-update-packaging.ts'

async function main(): Promise<void> {
  const [manifest, version, mode, ...extra] = process.argv.slice(2)
  if (!manifest || !version || extra.length !== 0 || (mode !== undefined && mode !== '--check' && mode !== '--execute')) {
    throw new Error('invalid invocation')
  }
  const result = await packageInstalledUpdate(manifest, version, { execute: mode === '--execute',
    confirm: async (id, selectedVersion) => {
      if (!stdin.isTTY || !stdout.isTTY) return false
      const terminal = createInterface({ input: stdin, output: stdout })
      try {
        console.log('仅在管理员已审核并恢复签名保护后继续。确认已注销令牌、剩余 5/5、PIN 正确且无其他签名任务。')
        console.log('本次打包会有多次签名；不重试失败操作，驱动内部认证次数无法保证。出现密码弹窗请取消，不要补输。')
        console.log('PIN 只从 .env.windows 读取；签名接口要求它短暂出现在 SignTool 参数中。不会安装或上传。')
        const expected = `PACKAGE ${selectedVersion} ${id}`
        return (await terminal.question(`仅授权这个版本，请输入 ${expected}：`)) === expected
      } finally { terminal.close() }
    } })
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error: unknown) => {
  console.error(error instanceof InstalledUpdateSigningHoldError ? error.message
    : 'installed update packaging stopped. Check prepared files and the retained record; do not retry or remove protection automatically.')
  process.exitCode = 1
})
