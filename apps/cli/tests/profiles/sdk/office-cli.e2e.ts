/**
 * PDF export through the shipped SDK profile: the agent loads an Office skill, converts with `office_convert`, and
 * copies the temporary PDF into the workspace with the shell, with no Node on PATH.
 * Defaults to built Node packages. DSH_OFFICE_TEST_EXECUTABLE/ENTRY select a relocated Node or Electron carrier;
 * CARRIER=sdk selects the standalone executable. API=openai-completions selects a development gateway instead of the
 * default Messages API.
 */
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { execa } from 'execa'
import { strToU8, zipSync } from 'fflate'
import { expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
const carrier = process.env.DSH_OFFICE_TEST_CARRIER ?? 'npm'
const executable = process.env.DSH_OFFICE_TEST_EXECUTABLE ?? process.execPath
const entry = process.env.DSH_OFFICE_TEST_ENTRY ?? join(repo, 'apps/cli/lib/bin.js')

/** One model tool call reported by the SDK event stream. */
interface ToolCall {
  readonly name?: string
  readonly arguments?: unknown
}

function callArguments(call: ToolCall): Record<string, unknown> {
  if (typeof call.arguments !== 'string') throw new Error(`Tool call ${call.name} did not contain serialized arguments`)
  return JSON.parse(call.arguments) as Record<string, unknown>
}

it.skipIf(!process.env.DEEPSEEK_API_KEY || process.platform === 'win32')(`agent exports a PDF with office_convert in the ${carrier} carrier without Node on PATH`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh office export '))
  try {
    const source = zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Office PDF export</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'),
    })
    await writeFile(join(root, 'input.docx'), source)
    const patch = join(root, 'office.patch.yml')
    await writeFile(patch, JSON.stringify([
      ...(process.env.DSH_OFFICE_TEST_API === 'openai-completions' ? [{ id: 'llm-deepseek', disabled: true }, { id: 'llm-pi-ai', config: { providers: { 'office-test': { api: 'openai-completions', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: process.env.DEEPSEEK_BASE_URL, compat: { thinkingFormat: 'deepseek' }, models: [{ id: process.env.MODEL_NAME ?? 'deepseek-v4-flash', contextWindow: 128000, maxTokens: 8000 }] } } } }] : []),
      { id: 'session-persistence-jsonl', config: { root: join(root, 'sessions'), compression: 'none' } },
    ]))
    // A private POSIX tool directory also excludes /usr/bin/node on Linux.
    const path = join(root, 'bin')
    await mkdir(path)
    for (const name of ['bash', 'sh', 'cat', 'cp', 'ls', 'head', 'tail', 'mkdir', 'od', 'wc']) {
      const binary = (existsSync('/bin/' + name) ? '/bin/' : '/usr/bin/') + name
      await access(binary)
      await symlink(binary, join(path, name))
    }
    const decoyMarker = join(root, 'system-office-invoked')
    for (const name of ['libreoffice', 'soffice']) {
      const decoy = join(path, name)
      await writeFile(decoy, '#!/bin/sh\nprintf invoked > ' + "'" + decoyMarker.replaceAll("'", "'\\''") + "'" + '\nexit 86\n')
      await chmod(decoy, 0o755)
    }
    const lookup = await execa('/bin/sh', ['-c', 'command -v node'], { env: { PATH: path }, reject: false })
    expect(lookup.exitCode, 'the fixture must not expose Node through PATH').not.toBe(0)
    const child = execa(executable, [
      ...carrier === 'sdk' ? [] : [entry], '--profile', 'sdk', '--patch', patch,
    ], {
      cwd: root, env: {
        PATH: path, DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'),
        DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1',
        DSH_PRIMARY_RUNTIME: carrier === 'sdk' ? undefined : process.env.DSH_PRIMARY_RUNTIME,
      },
      timeout: 110_000, killSignal: 'SIGKILL', reject: false,
    })
    const lines = createInterface({ input: child.stdout })
    const records: Record<string, unknown>[] = []
    let protocolError: Error | undefined
    const send = (id: number, method: string, params?: object): void => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    }
    lines.on('line', (line) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        records.push(value)
        if (value.id === 1) send(2, 'session/prompt', { sessionId: 'main', contentBlocks: [{ type: 'text', text:
          'Export input.docx to result.pdf in this directory. Use the supplied tools; do not install anything. Report briefly after the file exists.',
        }] })
        const params = value.params as { event?: { type?: string } } | undefined
        if (value.error !== undefined || params?.event?.type === 'turn/end') send(3, 'shutdown')
      } catch (error) {
        protocolError = error instanceof Error ? error : new Error(String(error))
        child.kill('SIGKILL')
      }
    })
    try {
      send(1, 'initialize', { cwd: root, provider: process.env.DSH_OFFICE_TEST_API === 'openai-completions' ? 'office-test' : 'deepseek-official', model: process.env.MODEL_NAME ?? 'deepseek-v4-flash', maxTokens: 8000 })
      const result = await child
      const diagnostic = `${result.stderr}\n${result.stdout}`
      expect(protocolError, diagnostic).toBeUndefined()
      expect(result.timedOut, diagnostic).toBe(false)
      expect(result.signal, diagnostic).toBeUndefined()
      expect(result.exitCode, diagnostic).toBe(0)
      expect(records.filter(record => record.error !== undefined), diagnostic).toEqual([])
      const calls = records.flatMap((record) => {
        const params = record.params as { event?: { type: string; data: ToolCall } } | undefined
        return params?.event?.type === 'tool/call' ? [params.event.data] : []
      })
      const skill = calls.findIndex(call => call.name === 'skill')
      const convert = calls.findIndex(call => call.name === 'office_convert' && callArguments(call).format === 'pdf')
      const copy = calls.findIndex(call => call.name === 'bash' && /\bcp\b/u.test(String(callArguments(call).command)))
      expect(skill, diagnostic).toBeGreaterThanOrEqual(0)
      expect(convert, diagnostic).toBeGreaterThan(skill)
      expect(copy, diagnostic).toBeGreaterThan(convert)
      expect(existsSync(decoyMarker), 'the agent must not invoke system Office').toBe(false)
      const pdf = await readFile(join(root, 'result.pdf'))
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
      expect(pdf.length).toBeGreaterThan(1000)
      expect(await readFile(join(root, 'input.docx'))).toEqual(Buffer.from(source))
    } finally {
      lines.close()
      child.stdin.end()
      child.kill('SIGKILL')
      await child
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
