#!/usr/bin/env node
/**
 * Test driver: boot the tool-pwsh Loader composition, execute one real
 * foreground and one real background pwsh command through the tool registry,
 * and persist the observed model-visible output to `./pwsh-loader-report.json`
 * for the package spec's inspect step.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('tool-pwsh driver requires a config path')

const ctx = await boot('tool-pwsh-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  const schema = ctx.tools.schemas().find(tool => tool.name === 'pwsh')
  if (schema === undefined) throw new Error('pwsh tool not registered by the composition')
  const prompt = (await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tool:pwsh')

  const foreground = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('loader-fg'),
    name: 'pwsh',
    arguments: { command: 'Write-Output loader-ok', description: 'loader foreground' },
  })
  const foregroundText = foreground.content.filter(block => block.type === 'text').map(block => block.text).join('')

  const background = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('loader-bg'),
    name: 'pwsh',
    arguments: {
      command: 'Start-Sleep -Milliseconds 200; Write-Output loader-bg-ok',
      description: 'loader background',
      run_in_background: true,
    },
  })
  const jobId = (background.value as { jobId: string }).jobId

  // The output delta and the terminal status can land in separate reads
  // (Windows flushes the child pipe at exit), so accumulate both.
  let backgroundText = ''
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const read = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('loader-bg-read'),
      name: 'job_output',
      arguments: { job_id: jobId },
    })
    backgroundText += read.content.filter(block => block.type === 'text').map(block => block.text).join('')
    if (backgroundText.includes('loader-bg-ok') && backgroundText.includes('[status: completed')) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  await writeFile('./pwsh-loader-report.json', JSON.stringify({
    schemaHasRunInBackground: Object.hasOwn(schema.parameters.properties as object, 'run_in_background'),
    promptHasMarkerSection: prompt?.text.includes('Non-zero exits are reported as `[exit code: N]` markers') === true,
    // Normalize PowerShell's platform line endings (CRLF on Windows, LF elsewhere).
    foregroundText: foregroundText.replace(/\r\n/g, '\n'),
    foregroundCwd: (foreground.value as { cwd: string }).cwd,
    foregroundMeta: foreground.meta,
    backgroundText: backgroundText.replace(/\r\n/g, '\n'),
    backgroundCwd: (background.value as { cwd: string }).cwd,
    backgroundMeta: background.meta,
  }))
} finally {
  await ctx.fiber.dispose()
}
