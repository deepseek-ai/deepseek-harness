/** Operator entry for separate test binary uploads and fixed-feed publication; default mode is local-only. */
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { verifiedInstalledUpdateDistribution, executeInstalledUpdatePublication } from './installed-update-publication.ts'
import { createInstalledUpdateCos } from './installed-update-cos.ts'

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    execute: { type: 'boolean', default: false }, journals: { type: 'string' },
  } })
  const [action, manifest, version, receipt, ...extra] = positionals
  if ((action !== 'upload-binaries' && action !== 'publish-feed') || !manifest || !version || !receipt || extra.length) {
    throw new Error('invalid invocation')
  }
  const prepared = await verifiedInstalledUpdateDistribution(manifest, version, receipt)
  console.log(JSON.stringify({ action, version, runId: prepared.run.id, destination: prepared.distribution,
    mode: values.execute ? 'awaiting-operator' : 'local-check', networkStarted: false }, null, 2))
  if (!values.execute) return
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('operator terminal required')
  const expected = `${action === 'upload-binaries' ? 'UPLOAD' : 'PUBLISH'} ${version} ${prepared.run.id}`
  const terminal = createInterface({ input: stdin, output: stdout })
  let confirmed = false
  try {
    console.log(action === 'upload-binaries'
      ? '仅授权此批次 test 二进制上传。确认没有其他发布者；会完整回读安装包，可能产生较大下载流量。'
      : '仅授权此批次 test 清单发布。确认没有其他发布者；复用成功上传回执，仅回读清单，不重复下载安装包。')
    if (action === 'publish-feed' && version === prepared.run.versions[1]) {
      console.log('确认版本 1 已通过安装后的入口启动并仍在运行；必须提供该批次 journals 目录。')
    }
    confirmed = (await terminal.question(`请输入 ${expected}：`)) === expected
  } finally { terminal.close() }
  if (!confirmed) throw new Error('operator declined')
  console.log(await executeInstalledUpdatePublication(manifest, version, receipt, action, createInstalledUpdateCos(), values.journals))
}

main().catch(() => {
  console.error('installed update: upload/publication stopped. Review local prerequisites and any retained operation record; no automatic retry.')
  process.exitCode = 1
})
