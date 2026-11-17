import { Context } from '@deepseek-ai/cordis'
import { PtcImage, PtcInspectableValue, type PtcBindingNamespace, type PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import { mountRuntime } from './setup.ts'

const modes = [
  { executionMode: 'per-call' },
  { executionMode: 'vm-script' },
  { executionMode: 'vm-script', scriptPersistence: true },
  { executionMode: 'persistent-in-memory', replScoped: false },
  { executionMode: 'persistent-in-memory', replScoped: true },
] as const

const data = { path: '/a.txt', lines: [{ number: 1, text: 'alpha' }], totalLines: 1 }
const text = '<path>/a.txt</path>\n1: alpha'
function bindings(): PtcBindingNamespace[] {
  return [{ global: 'tools', functions: {
    read: async () => new PtcInspectableValue(data, text),
    list: async () => new PtcInspectableValue([1, 2, 3], 'three items\n'),
    scalar: async () => 42,
    empty: async () => new PtcInspectableValue({}, ''),
    echo: async args => args as PtcJsonValue,
  } }]
}


describe.each(modes)('binding inspection in $executionMode with script retention $scriptPersistence and scoped REPL $replScoped', (mode) => {
  it('uses binding text while preserving data fields, JSON, and subsequent binding arguments', async () => {
    const { runtime } = await mountRuntime(new Context(), mode)
    const result = await runtime.run(runtime.resolve({
      program: `
        const result = await tools.read({});
        if (Reflect.ownKeys(result).join() !== 'path,lines,totalLines') throw new Error('unexpected fields');
        if (result.lines[0].text !== 'alpha' || result.totalLines + 2 !== 3) throw new Error('data access failed');
        const echoed = await tools.echo(result);
        if (JSON.stringify(result) !== JSON.stringify(echoed)) throw new Error('data changed');
        inspect(result);
        inspect(await tools.list({}));
        inspect(await tools.scalar({}));
        inspect(await tools.empty({}));
      `,
      bindings: bindings(), discardCompletion: true,
    }))
    expect(result.error).toBeUndefined()
    expect(result.output).toEqual([
      { type: 'text', text: text + '\n' },
      { type: 'text', text: 'three items\n' },
      { type: 'text', text: '42\n' },
    ])
  })

  it('keeps host-issued Image fields usable inside inspectable containers', async () => {
    const { runtime } = await mountRuntime(new Context(), mode)
    const image = new PtcImage('/images/selected.png', {
      attachmentId: brandString<AttachmentId>('sha256:selected'), mediaType: 'image/png', bytes: 64, width: 8, height: 4,
    })
    const result = await runtime.run(runtime.resolve({
      program: 'const result = await tools.capture({}); inspect(result); inspect(result.shot); inspect(result.shot.width);',
      bindings: [{ global: 'tools', functions: { capture: async () => new PtcInspectableValue({ shot: image }, 'selected screenshot') } }],
      discardCompletion: true,
    }))
    expect(result.error).toBeUndefined()
    expect(result.output).toEqual([
      { type: 'text', text: 'selected screenshot\n' },
      { type: 'image', attachment: image.attachment },
      { type: 'text', text: '8\n' },
    ])
  })

  it('formats modified, copied, selected, and nested data without reusing the original text', async () => {
    const { runtime } = await mountRuntime(new Context(), mode)
    const result = await runtime.run(runtime.resolve({
      program: `
        const result = await tools.read({});
        inspect({ ...result });
        inspect({ result });
        inspect(result.lines);
        result.lines[0].text = 'changed';
        inspect(result);
        result.lines[0].text = 'alpha';
        inspect(result);
        delete result.totalLines;
        inspect(result);
      `,
      bindings: bindings(), discardCompletion: true,
    }))
    expect(result.error).toBeUndefined()
    const output = result.output.filter(block => block.type === 'text').map(block => block.text)
    expect(output).toHaveLength(6)
    expect(output.slice(0, 4).join('')).not.toContain('<path>')
    expect(output[2]).toBe("[ { number: 1, text: 'alpha' } ]\n")
    expect(output[3]).toContain("text: 'changed'")
    expect(output[4]).toBe(text + '\n')
    expect(output[5]).not.toContain('totalLines')
  })

  it('falls back for accessors and cycles without invoking getters', async () => {
    const { runtime } = await mountRuntime(new Context(), mode)
    const result = await runtime.run(runtime.resolve({
      program: `
        const result = await tools.read({});
        let reads = 0;
        Object.defineProperty(result, 'totalLines', { enumerable: true, get() { reads++; return 1; } });
        inspect(result);
        inspect(reads);
        delete result.totalLines;
        result.self = result;
        inspect(result);
      `,
      bindings: bindings(), discardCompletion: true,
    }))
    expect(result.error).toBeUndefined()
    expect(result.output[0]).toMatchObject({ type: 'text', text: expect.stringContaining('[Getter]') as string })
    expect(result.output[1]).toEqual({ type: 'text', text: '0\n' })
    expect(result.output[2]).toMatchObject({ type: 'text', text: expect.stringContaining('[Circular *1]') as string })
  })
})

it('detects changed data when the program replaces Array.prototype.pop', async () => {
  const { runtime } = await mountRuntime(new Context(), { executionMode: 'per-call' })
  const result = await runtime.run(runtime.resolve({
    program: `
      const result = await tools.read({});
      result.lines[0].text = 'changed';
      const originalPop = Array.prototype.pop;
      try {
        Array.prototype.pop = () => undefined;
        inspect(result);
      } finally {
        Array.prototype.pop = originalPop;
      }
    `,
    bindings: bindings(), discardCompletion: true,
  }))
  expect(result.error).toBeUndefined()
  const output = result.output.filter(block => block.type === 'text').map(block => block.text).join('')
  expect(output).toContain("text: 'changed'")
  expect(output).not.toContain('<path>')
})

it.each(modes.filter(mode => mode.executionMode === 'persistent-in-memory' || 'scriptPersistence' in mode))('retains inspection text with data across calls in %j', async (mode) => {
  const { runtime } = await mountRuntime(new Context(), mode)
  const stateOwner = {}
  const first = await runtime.run(runtime.resolve({
    program: 'var retained = await tools.read({});', bindings: bindings(), stateOwner, discardCompletion: true,
  }))
  expect(first.error).toBeUndefined()
  expect(first.output).toEqual([])
  const second = await runtime.run(runtime.resolve({
    program: 'inspect(retained);', bindings: [], stateOwner, discardCompletion: true,
  }))
  expect(second.error).toBeUndefined()
  expect(second.output).toEqual([{ type: 'text', text: text + '\n' }])
})

it('charges inspection text only when emitted and bounds its complete output', async () => {
  const { runtime } = await mountRuntime(new Context(), { maxOutputBytes: 64 })
  const binding: PtcBindingNamespace[] = [{ global: 'tools', functions: {
    read: async () => new PtcInspectableValue({ value: 1 }, '€'.repeat(100)),
  } }]
  const hidden = await runtime.run(runtime.resolve({
    program: 'await tools.read({});', bindings: binding, discardCompletion: true,
  }))
  expect(hidden.error).toBeUndefined()
  expect(hidden.output).toEqual([])
  const shown = await runtime.run(runtime.resolve({
    program: 'inspect(await tools.read({}));', bindings: binding, discardCompletion: true,
  }))
  expect(shown.error).toBeUndefined()
  expect(shown.outputTruncated).toBe(true)
})

it('rejects a non-JSON wrapped binding value instead of replacing it with rendered text', async () => {
  const { runtime } = await mountRuntime(new Context())
  const result = await runtime.run(runtime.resolve({
    program: 'try { await tools.read({}); } catch (error) { inspect(error.message); }',
    bindings: [{ global: 'tools', functions: { read: async () => new PtcInspectableValue({ value: Infinity }, 'hidden invalid data') } }],
    discardCompletion: true,
  }))
  expect(result.error).toBeUndefined()
  expect(result.output).toEqual([{ type: 'text', text: 'binding resolution must be lossless JSON\n' }])
})
