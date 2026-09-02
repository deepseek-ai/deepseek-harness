import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolStrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'

const contexts: Context[] = []
const roots: string[] = []
let callNumber = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function agent(ctx: Context, cwd: string): Agent {
  const id = SessionId(`str-replace-editor-owner-${callNumber}`)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd, isSeeded: false })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function call(ctx: Context, owner: Agent | undefined, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`str-replace-editor-${++callNumber}`),
    name: 'str_replace_editor',
    arguments: args,
    ...owner === undefined ? {} : { agent: owner },
  })
}

async function setup(
  config: ToolStrReplaceEditor.Config = {},
  options: { fsPolicy?: boolean; sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-str-replace-editor-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (options.sandboxMode === undefined) {
    await ctx.plugin(LocalFileSystem, { cwd: root })
  } else {
    // SandboxPolicy declares the registry as a required injection; mount it
    // before the policy activates.
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicy, { mode: options.sandboxMode, workspaceRoot: root })
    await ctx.plugin(SandboxedFileSystem, { cwd: root })
  }
  if (options.fsPolicy === true) await ctx.plugin(FsPolicy)
  const fiber = await ctx.plugin(ToolStrReplaceEditor, config)
  return { ctx, root, fiber, owner: agent(ctx, root) }
}

describe('tool-str-replace-editor', () => {
  it('registers the standalone schema and configurable description', async () => {
    const { ctx, fiber } = await setup({ description: 'custom editor description' })
    const schema = ctx.tools.schemas()[0]
    expect(ctx.tools.schemas().map(item => item.name)).toEqual(['str_replace_editor'])
    expect(schema?.description).toBe('custom editor description')
    const properties = (schema?.parameters as {
      properties: Record<string, {
        type?: string
        items?: { type?: string }
        oneOf?: { type?: string; items?: { type?: string } }[]
      }>
    }).properties
    expect(properties).not.toHaveProperty('replace_all')
    expect(properties.file_text?.oneOf?.map(option => option.type)).toEqual(['string', 'null'])
    expect(properties.insert_line?.oneOf?.map(option => option.type)).toEqual(['integer', 'null'])
    expect(properties.new_str?.oneOf?.map(option => option.type)).toEqual(['string', 'null'])
    expect(properties.old_str?.oneOf?.map(option => option.type)).toEqual(['string', 'null'])
    expect(properties.view_range?.oneOf?.map(option => option.type)).toEqual(['array', 'null'])
    expect(properties.view_range?.oneOf?.[0]?.items?.type).toBe('integer')
    expect(ctx.tools.get('str_replace_editor')?.presentCall?.({
      command: 'view',
      path: '/workspace/a.txt',
      file_text: null,
      insert_line: null,
      new_str: null,
      old_str: null,
      view_range: null,
    })).toMatchObject({
      card: 'generic',
      kind: 'read',
      locations: [{ path: '/workspace/a.txt' }],
    })
    expect(ctx.tools.get('str_replace_editor')?.presentCall?.({
      command: 'create',
      path: '/workspace/a.txt',
      file_text: 'hello',
      insert_line: null,
      new_str: null,
      old_str: null,
      view_range: null,
    })).toMatchObject({
      card: 'diff',
      diffs: [{ path: '/workspace/a.txt', oldText: null, newText: 'hello' }],
    })
    expect(ctx.tools.get('str_replace_editor')?.presentCall?.({
      command: 'str_replace',
      path: '/workspace/a.txt',
      old_str: 'old',
      new_str: 'new',
      file_text: null,
      insert_line: null,
      view_range: null,
    })).toMatchObject({
      card: 'diff',
      diffs: [{ path: '/workspace/a.txt', oldText: 'old', newText: 'new' }],
    })
    expect(ctx.tools.get('str_replace_editor')?.presentCall?.({
      command: 'insert',
      path: '/workspace/a.txt',
      insert_line: null,
      new_str: 'x',
    })).toMatchObject({
      card: 'generic',
      kind: 'edit',
      locations: [{ path: '/workspace/a.txt' }],
    })
    expect(ctx.tools.get('str_replace_editor')?.presentCall?.({
      command: 'insert',
      path: '/workspace/a.txt',
      insert_line: 0,
      new_str: 'x',
      file_text: null,
      old_str: null,
      view_range: null,
    })).toMatchObject({
      card: 'generic',
      kind: 'edit',
      locations: [{ path: '/workspace/a.txt', line: 1 }],
    })
    expect(ctx.tools.get('str_replace_editor')?.presentCall?.({
      command: 'create',
      path: '/workspace/empty.txt',
    })).toMatchObject({
      diffs: [{ path: '/workspace/empty.txt', oldText: null, newText: '' }],
    })
    expect(ctx.tools.get('str_replace_editor')?.presentCall?.({
      command: 'str_replace',
      path: '/workspace/a.txt',
    })).toMatchObject({
      diffs: [{ path: '/workspace/a.txt', oldText: null, newText: '' }],
    })
    expect(ctx.tools.get('str_replace_editor')?.presentCall?.({
      command: 'insert',
      path: '/workspace/a.txt',
    })).toMatchObject({
      locations: [{ path: '/workspace/a.txt' }],
    })

    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.tools.get('str_replace_editor')).toBeUndefined()
  })

  it('creates, views, replaces, and inserts with the canonical model-facing output', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'sample.txt')
    expect(text(await call(ctx, owner, {
      command: 'create',
      path: sample,
      file_text: 'one\ntwo\nthree\n',
      insert_line: null,
      new_str: null,
      old_str: null,
      view_range: null,
    }))).toBe(`New file created successfully at: ${sample}`)

    expect(text(await call(ctx, owner, {
      command: 'view',
      path: sample,
      file_text: null,
      insert_line: null,
      new_str: null,
      old_str: null,
      view_range: null,
    }))).toContain('     2  two')

    expect(text(await call(ctx, owner, {
      command: 'view',
      path: sample,
      view_range: [2, -1],
    }))).toBe([
      `Here's the content of ${sample} with line numbers (which has a total of 4 lines) with view_range=[2, -1]:`,
      '     2  two',
      '     3  three',
      '     4  ',
      '',
    ].join('\n'))

    expect(text(await call(ctx, owner, {
      command: 'str_replace',
      path: sample,
      old_str: 'two',
      new_str: 'TWO',
      file_text: null,
      insert_line: null,
      view_range: null,
    }))).toBe(`The file ${sample} has been edited successfully.`)
    expect(text(await call(ctx, owner, {
      command: 'str_replace',
      path: sample,
      old_str: 'TWO',
    }))).toBe(`The file ${sample} has been edited successfully.`)
    expect(text(await call(ctx, owner, {
      command: 'insert',
      path: sample,
      insert_line: 1,
      new_str: 'between',
      file_text: null,
      old_str: null,
      view_range: null,
    }))).toBe(`The file ${sample} has been edited successfully.`)
    expect(await readFile(sample, 'utf8')).toBe('one\nbetween\n\nthree\n')
  })

  it('a failed view records absence so create can recover after external deletion', async () => {
    const { ctx, root, owner } = await setup({}, { fsPolicy: true })
    const sample = join(root, 'deleted.txt')
    await writeFile(sample, 'original')
    expect((await call(ctx, owner, { command: 'view', path: sample })).isError).toBe(false)
    await rm(sample)

    const missing = await call(ctx, owner, { command: 'view', path: sample })
    expect(missing.isError).toBe(true)
    expect(missing.error).toMatchObject({ info: { code: 'FS_NOT_FOUND' } })

    const edit = await call(ctx, owner, {
      command: 'str_replace',
      path: sample,
      old_str: 'original',
      new_str: 'edited',
    })
    expect(edit.isError).toBe(true)
    expect(edit.error).toMatchObject({ info: { code: 'FS_NOT_FOUND' } })

    const created = await call(ctx, owner, {
      command: 'create',
      path: sample,
      file_text: 'fresh',
    })
    expect(created.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('fresh')
  })

  it('writes replacement text literally', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'literal.txt')
    const replacement = "$&|$`|$'|$$"
    await writeFile(sample, 'before OLD after')

    expect((await call(ctx, owner, {
      command: 'str_replace',
      path: sample,
      old_str: 'OLD',
      new_str: replacement,
    })).isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe(`before ${replacement} after`)
  })

  it('lists visible entries to depth two and clips at the configured view limit', async () => {
    const { ctx, root, owner } = await setup({ maxOutputChars: 10_000 })
    await mkdir(join(root, 'dir', 'nested', 'third'), { recursive: true })
    await mkdir(join(root, 'dir', 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(root, 'dir', 'node_modules_old'), { recursive: true })
    await mkdir(join(root, 'dir', '__pycache__'), { recursive: true })
    await mkdir(join(root, 'dir', '__pycache__backup'), { recursive: true })
    await writeFile(join(root, 'dir', 'visible.txt'), 'ok')
    await writeFile(join(root, 'dir', '.hidden'), 'hidden')
    await writeFile(join(root, 'dir', 'nested', 'child.txt'), 'child')
    await writeFile(join(root, 'dir', 'nested', 'third', 'too-deep.txt'), 'deep')
    await writeFile(join(root, 'dir', 'node_modules', 'pkg', 'index.js'), 'hidden dependency')
    await writeFile(join(root, 'dir', 'node_modules_old', 'kept.js'), 'visible source')
    await writeFile(join(root, 'dir', '__pycache__', 'module.pyc'), 'cache')
    await writeFile(join(root, 'dir', '__pycache__backup', 'kept.py'), 'visible source')
    const listDir = ctx.fs.listDir.bind(ctx.fs)
    const otherTarget = await ctx.fs.resolve(join(root, 'dir', 'other'))
    ctx.fs.listDir = async (target, signal) => {
      const entries = await listDir(target, signal)
      return target.displayPath === join(root, 'dir')
        ? [
          { name: 'same-target', type: 'other', target: otherTarget },
          { name: 'other', type: 'other', target: otherTarget },
          ...entries.toReversed(),
        ]
        : entries
    }

    const listing = text(await call(ctx, owner, { command: 'view', path: join(root, 'dir') }))
    expect(listing).not.toContain('.hidden')
    expect(listing).not.toContain('too-deep.txt')
    expect(listing).not.toContain('index.js')
    expect(listing).not.toContain('module.pyc')
    // The listing carries absolute display paths; the POSIX-style substrings
    // only match on Linux, so assert with platform separators.
    expect(listing).toContain(join('node_modules_old', 'kept.js'))
    expect(listing).toContain(join('__pycache__backup', 'kept.py'))

    const clipped = await setup({ maxOutputChars: 10 })
    await writeFile(join(clipped.root, 'large.txt'), 'x'.repeat(100))
    expect(text(await call(clipped.ctx, clipped.owner, {
      command: 'view',
      path: join(clipped.root, 'large.txt'),
    })))
      .toContain('<response clipped>')
  })

  it('matches canonical empty-line, range, and end-insert behavior', async () => {
    const { ctx, root, owner } = await setup()
    const empty = join(root, 'empty.txt')
    const newline = join(root, 'newline.txt')
    const plain = join(root, 'plain.txt')
    await writeFile(empty, '')
    await writeFile(newline, '\n')
    await writeFile(plain, 'one\ntwo')

    expect(text(await call(ctx, owner, { command: 'view', path: empty })))
      .toContain('(which has a total of 1 lines):\n     1  \n')
    expect(text(await call(ctx, owner, { command: 'view', path: newline })))
      .toContain('(which has a total of 2 lines):\n     1  \n     2  \n')
    expect(text(await call(ctx, owner, {
      command: 'view',
      path: plain,
      view_range: [1, 2],
    }))).toContain('     2  two')
    expect(text(await call(ctx, undefined, {
      command: 'view',
      path: plain,
    }))).toContain('     1  one')
    expect((await call(ctx, undefined, {
      command: 'create',
      path: join(root, 'ownerless.txt'),
      file_text: 'ownerless',
    })).isError).toBe(false)

    await call(ctx, owner, {
      command: 'insert',
      path: plain,
      insert_line: 2,
      new_str: 'three',
    })
    expect(await readFile(plain, 'utf8')).toBe('one\ntwo\nthree')

    await writeFile(newline, 'one\n')
    await call(ctx, owner, {
      command: 'insert',
      path: newline,
      insert_line: 2,
      new_str: 'three',
    })
    expect(await readFile(newline, 'utf8')).toBe('one\n\nthree')
  })

  it('uses old_str-only replacement failures and rejects relative paths', async () => {
    const { ctx, root, owner } = await setup()
    const ambiguous = join(root, 'ambiguous.txt')
    await writeFile(ambiguous, 'same\nother\nsame')

    const missing = await call(ctx, owner, {
      command: 'str_replace',
      path: ambiguous,
      old_str: 'absent',
      new_str: 'x',
    })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain(`old_str \`absent\` did not appear verbatim in ${ambiguous}`)
    expect(text(missing)).not.toContain('old_string')

    const repeated = await call(ctx, owner, {
      command: 'str_replace',
      path: ambiguous,
      old_str: 'same',
      new_str: 'x',
    })
    expect(repeated.isError).toBe(true)
    expect(text(repeated)).toContain('Multiple occurrences of old_str `same` in lines [1, 3]')
    expect(text(repeated)).not.toContain('replace_all')

    await writeFile(ambiguous, 'alpha\nbeta\nmiddle\nalpha\nbeta')
    const repeatedMultiline = await call(ctx, owner, {
      command: 'str_replace',
      path: ambiguous,
      old_str: 'alpha\nbeta',
      new_str: 'x',
    })
    expect(text(repeatedMultiline))
      .toContain('Multiple occurrences of old_str `alpha\nbeta` in lines [1, 4]')

    const mixedEol = join(root, 'mixed-eol.txt')
    await writeFile(mixedEol, 'alpha\r\nbeta\nmiddle\nalpha\nbeta')
    expect((await call(ctx, owner, {
      command: 'str_replace',
      path: mixedEol,
      old_str: 'alpha\r\nbeta',
      new_str: 'replaced',
    })).isError).toBe(false)
    expect(await readFile(mixedEol, 'utf8')).toBe('replaced\nmiddle\nalpha\nbeta')

    const relative = await call(ctx, owner, { command: 'view', path: 'ambiguous.txt' })
    expect(relative.isError).toBe(true)
    expect(text(relative)).toContain('is not an absolute path')
    expect(await readFile(ambiguous, 'utf8')).toBe('alpha\nbeta\nmiddle\nalpha\nbeta')
  })

  it('reports invalid commands or arguments without mutating files', async () => {
    const { ctx, root, owner } = await setup()
    const ambiguous = join(root, 'ambiguous.txt')
    const empty = join(root, 'empty.txt')
    const trailingNewline = join(root, 'trailing-newline.txt')
    const threeLines = join(root, 'three-lines.txt')
    const directory = join(root, 'directory')
    await writeFile(ambiguous, 'same same')
    await writeFile(empty, '')
    await writeFile(trailingNewline, 'one\n')
    await writeFile(threeLines, 'one\ntwo\nthree')
    await mkdir(directory)

    const cases = [
      { command: null, path: ambiguous },
      { command: 'view', path: null },
      { command: 'view', path: '' },
      { command: 'view', path: join(root, 'missing.txt') },
      { command: 'view', path: ambiguous, view_range: [1] },
      { command: 'view', path: ambiguous, view_range: [0, 1] },
      { command: 'view', path: ambiguous, view_range: [1.5, 2] },
      { command: 'view', path: threeLines, view_range: [1, 99] },
      { command: 'view', path: threeLines, view_range: [2, 1] },
      { command: 'view', path: directory, view_range: [1, 1] },
      { command: 'create', path: join(root, 'new.txt') },
      { command: 'create', path: join(root, 'new.txt'), file_text: null },
      { command: 'create', path: ambiguous, file_text: 'overwrite' },
      { command: 'str_replace', path: ambiguous, new_str: 'x' },
      { command: 'str_replace', path: ambiguous, old_str: null, new_str: 'x' },
      { command: 'str_replace', path: ambiguous, old_str: 'same same', new_str: null },
      { command: 'str_replace', path: ambiguous, old_str: '', new_str: 'x' },
      { command: 'insert', path: ambiguous, new_str: 'x' },
      { command: 'insert', path: ambiguous, insert_line: null, new_str: 'x' },
      { command: 'insert', path: ambiguous, insert_line: 0, new_str: null },
      { command: 'insert', path: ambiguous, insert_line: -1, new_str: 'x' },
      { command: 'insert', path: ambiguous, insert_line: 1.5, new_str: 'x' },
      { command: 'insert', path: ambiguous, insert_line: 99, new_str: 'x' },
      { command: 'insert', path: empty, insert_line: 2, new_str: 'x' },
      { command: 'insert', path: directory, insert_line: 0, new_str: 'x' },
    ]
    for (const args of cases) {
      expect((await call(ctx, owner, args)).isError).toBe(true)
    }
    expect(await readFile(ambiguous, 'utf8')).toBe('same same')

    ctx.fs.stat = async () => ({ version: FsVersion('special'), type: 'other' })
    const special = await call(ctx, owner, { command: 'view', path: join(root, 'special') })
    expect(special.isError).toBe(true)
    expect(special.error).toMatchObject({ info: { code: 'FS_NOT_REGULAR_FILE' } })
    expect((await call(ctx, owner, {
      command: 'str_replace',
      path: join(root, 'special'),
      old_str: 'x',
      new_str: 'y',
    })).error).toMatchObject({ info: { code: 'FS_NOT_REGULAR_FILE' } })
    expect((await call(ctx, owner, {
      command: 'insert',
      path: join(root, 'special'),
      insert_line: 0,
      new_str: 'x',
    })).error).toMatchObject({ info: { code: 'FS_NOT_REGULAR_FILE' } })
  })

  it('delegates read-before-edit decisions to fs-observation-policy', async () => {
    const { ctx, root, owner } = await setup({}, { fsPolicy: true })
    const existing = join(root, 'existing.txt')
    const created = join(root, 'created.txt')
    await writeFile(existing, 'before')

    const blindEdit = await call(ctx, owner, {
      command: 'str_replace',
      path: existing,
      old_str: 'before',
      new_str: 'after',
    })
    expect(blindEdit.error).toMatchObject({ info: { code: 'FS_NOT_OBSERVED' } })
    expect(await readFile(existing, 'utf8')).toBe('before')

    await call(ctx, owner, { command: 'view', path: existing })
    expect((await call(ctx, owner, {
      command: 'str_replace',
      path: existing,
      old_str: 'before',
      new_str: 'after',
    })).isError).toBe(false)
    expect(await readFile(existing, 'utf8')).toBe('after')

    expect((await call(ctx, owner, {
      command: 'insert',
      path: existing,
      insert_line: 1,
      new_str: 'tail',
    })).isError).toBe(false)
    expect(await readFile(existing, 'utf8')).toBe('after\ntail')

    expect((await call(ctx, owner, {
      command: 'create',
      path: created,
      file_text: 'new',
    })).isError).toBe(false)
    expect(await readFile(created, 'utf8')).toBe('new')
  })

  it('passes the session sandbox policy to every mutation', async () => {
    const { ctx, root, owner } = await setup({}, { sandboxMode: 'read-only' })
    const path = join(root, 'blocked.txt')
    const result = await call(ctx, owner, {
      command: 'create',
      path,
      file_text: 'blocked',
    })
    expect(result.error).toMatchObject({ info: { code: 'FS_SANDBOX_DENIED' } })
    expect(text(result)).toContain('[sandbox: file access denied under read-only mode]')

    const ownerless = await call(ctx, undefined, {
      command: 'create',
      path: join(root, 'ownerless-blocked.txt'),
      file_text: 'blocked',
    })
    expect(ownerless.error).toMatchObject({ info: { code: 'FS_SANDBOX_DENIED' } })
  })

  it('preserves tabs outside the edited region', async () => {
    const { ctx, root, owner } = await setup()
    const path = join(root, 'Makefile')
    await writeFile(path, 'target:\n\told\nremove\n')
    expect(text(await call(ctx, owner, { command: 'view', path })))
      .toContain('     2  \told')
    await call(ctx, owner, {
      command: 'str_replace',
      path,
      old_str: '\told',
      new_str: '\tnew',
    })
    await call(ctx, owner, {
      command: 'str_replace',
      path,
      old_str: 'remove\n',
    })
    await call(ctx, owner, {
      command: 'insert',
      path,
      insert_line: 1,
      new_str: '\tkept',
    })
    expect(await readFile(path, 'utf8')).toBe('target:\n\tkept\n\tnew\n')
  })

  it('reports missing sandbox-policy composition during plugin startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-str-replace-editor-missing-policy-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    Object.defineProperty(ctx.fs, 'sandboxMode', { value: 'read-only' })

    await expect(ctx.plugin(ToolStrReplaceEditor))
      .rejects.toThrow('the mounted filesystem confines but ctx.sandboxPolicy is missing')
  })

  it('maps unexpected backend write failures for replace and insert', async () => {
    const { ctx, root, owner } = await setup()
    const path = join(root, 'backend-error.txt')
    await writeFile(path, 'old\n')
    const failWrite = async (): Promise<never> => {
      throw new Error('backend write failed')
    }
    ctx.fs.writeText = failWrite

    const replace = await call(ctx, owner, {
      command: 'str_replace',
      path,
      old_str: 'old',
      new_str: 'new',
    })
    expect(replace.isError).toBe(true)
    expect(text(replace)).toContain('backend write failed')

    const insert = await call(ctx, owner, {
      command: 'insert',
      path,
      insert_line: 1,
      new_str: 'new',
    })
    expect(insert.isError).toBe(true)
    expect(text(insert)).toContain('backend write failed')
  })

  it('rejects invalid plugin config', () => {
    expect(() => {
      ToolStrReplaceEditor.apply(new Context(), { maxOutputChars: 0 })
    }).toThrow('maxOutputChars must be a positive safe integer')
    expect(() => {
      ToolStrReplaceEditor.apply(new Context(), { description: ' ' })
    }).toThrow('description must be non-empty')
  })
})
