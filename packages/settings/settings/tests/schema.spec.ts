/** Form projection preserves live containers and removes secret defaults. */
import { expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { isVolatilePath, plainConfig, projectForm, volatileForm } from '../src/schema.ts'

it('exposes nested live fields while omitting ordinary fields', () => {
  const schema = z.object({
    ordinary: z.string(), nested: z.object({ fixed: z.string(), live: z.number().volatile() }), enabled: z.boolean().volatile(),
  })
  const form = volatileForm(schema)!
  expect(Object.keys(form.dict!)).toEqual(['nested', 'enabled'])
  expect(projectForm(form, { ordinary: 'hidden', nested: { fixed: 'hidden', live: 3 }, enabled: true })).toEqual({ nested: { live: 3 }, enabled: true })
  expect(isVolatilePath(schema, ['nested', 'live'])).toBe(true)
  expect(isVolatilePath(schema, ['nested', 'fixed'])).toBe(false)
  expect(isVolatilePath(schema, [])).toBe(false)
  expect(volatileForm(z.object({ fixed: z.string() }))).toBeUndefined()
  // A raw `!!js` expression is one node; projecting it field by field would replace it with `{}` on the next write.
  expect(projectForm(form, { nested: { __jsExpr: 'ctx.live' } })).toEqual({ nested: { __jsExpr: 'ctx.live' } })
})

it('detaches references and strips secret defaults throughout a live container', () => {
  const schema = z.object({
    secret: z.string().role('secret').default('hidden').required(),
    rows: z.array(z.object({ name: z.string(), token: z.string().role('secret') })).default([{ name: 'one', token: 'hidden' }]),
    mode: z.union(['one', 'two']).default('one'),
  }).volatile()
  const form = volatileForm(schema)!
  expect(JSON.stringify(form.toJSON())).not.toContain('hidden')
  expect(form.meta.volatile).toBeUndefined()
  expect(form.dict!.secret!.meta.required).toBeUndefined()
  const parsed = schema({ secret: 'private', rows: [{ name: 'two', token: 'private' }] })
  expect(plainConfig(parsed)).toEqual({ secret: 'private', rows: [{ name: 'two', token: 'private' }], mode: 'one' })
  expect(isVolatilePath(schema, ['rows', '0', 'token'])).toBe(true)
  expect(projectForm(form, null)).toBeNull()
  expect(projectForm(form, {})).toEqual({})
})

it('omits an object schema with no declared fields', () => {
  const schema = new z({ type: 'object' })
  expect(volatileForm(schema)).toBeUndefined()
  expect(projectForm(schema, { undeclared: true })).toEqual({})
})
