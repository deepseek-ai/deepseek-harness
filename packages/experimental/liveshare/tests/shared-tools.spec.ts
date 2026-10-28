/** The one table the source sandbox and a fork child's limit both admit tools from. */

import { describe, expect, it } from 'vitest'
import {
  SHARED_TOOL_PROFILES,
  describeSharedTool,
  sharedToolNames,
  sharedToolProfile,
  withDefaultSearchRoot,
} from '../src/host/shared-tools.ts'

describe('shared tool surface', () => {
  it('admits the view surface at both tiers and the two mutation tools only at write', () => {
    expect(sharedToolNames('view')).toEqual([
      'read', 'read_image', 'glob', 'grep', 'present', 'todo_write', 'skill', 'web_search', 'web_fetch',
    ])
    expect(sharedToolNames('write')).toEqual([...sharedToolNames('view'), 'edit', 'write'])
    expect(sharedToolProfile('read')).toMatchObject({ tier: 'view', noFileEffect: false })
    expect(sharedToolProfile('glob')).toMatchObject({ defaultsToWorkspace: true })
    expect(sharedToolProfile('todo_write')).toMatchObject({ noFileEffect: true, defaultsToWorkspace: false })
    expect(sharedToolProfile('edit')).toMatchObject({ tier: 'write' })
    expect(sharedToolProfile('bash')).toBeUndefined()
    expect(sharedToolProfile('ghost')).toBeUndefined()
    // Every entry names itself once, so a duplicated name cannot shadow another definition.
    const names = SHARED_TOOL_PROFILES.map(profile => profile.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('reads a named file’s path from each tool that takes one', () => {
    for (const name of ['read', 'read_image', 'edit', 'write']) {
      const profile = sharedToolProfile(name)
      if (profile === undefined) throw new Error(`no profile for ${name}`)
      const call = profile.call({ file_path: 'a.ts', other: 1 })
      expect(call?.paths).toEqual(['a.ts'])
      expect(call?.rewrite(['/granted/a.ts'])).toEqual({ file_path: '/granted/a.ts', other: 1 })
      expect(profile.call({ file_path: '' })).toBeUndefined()
      expect(profile.call({ file_path: 2 })).toBeUndefined()
      expect(profile.call({})).toBeUndefined()
    }
  })

  it('reads a search root and keeps the pathless default distinguishable', () => {
    for (const name of ['glob', 'grep']) {
      const profile = sharedToolProfile(name)
      if (profile === undefined) throw new Error(`no profile for ${name}`)
      // A call with no path names none, and the replacement supplies the workspace.
      expect(profile.call({ pattern: 'x' })?.paths).toEqual([])
      expect(profile.call({ pattern: 'x' })?.rewrite(['/granted'])).toEqual({ pattern: 'x', path: '/granted' })
      expect(profile.call({ pattern: 'x', path: 'src' })?.paths).toEqual(['src'])
      expect(profile.call({ pattern: 'x', path: 'src' })?.rewrite(['/granted/src']))
        .toEqual({ pattern: 'x', path: '/granted/src' })
      // An empty or unreadable path cannot establish a root, so the guard refuses the call.
      expect(profile.call({ pattern: 'x', path: '' })).toBeUndefined()
      expect(profile.call({ pattern: 'x', path: 2 })).toBeUndefined()
    }
  })

  it('reads every path a delivery names, preserving each entry’s other fields', () => {
    const profile = sharedToolProfile('present')
    if (profile === undefined) throw new Error('no present profile')
    const call = profile.call({
      files: [{ path: 'a.ts', description: 'A' }, { path: 'b.ts' }],
      extra: true,
    })
    expect(call?.paths).toEqual(['a.ts', 'b.ts'])
    expect(call?.rewrite(['/granted/a.ts', '/granted/b.ts'])).toEqual({
      files: [{ path: '/granted/a.ts', description: 'A' }, { path: '/granted/b.ts' }],
      extra: true,
    })
    expect(profile.call({ files: [] })?.paths).toEqual([])
    expect(profile.call({ files: 'not a list' })).toBeUndefined()
    expect(profile.call({ files: ['not a record'] })).toBeUndefined()
    expect(profile.call({ files: [{ description: 'no path' }] })).toBeUndefined()
    expect(profile.call({ files: [{ path: '' }] })).toBeUndefined()
    expect(profile.call({ files: [{ path: 2 }] })).toBeUndefined()
  })

  it('declares the tools that touch no workspace file and leaves their arguments alone', () => {
    for (const name of ['todo_write', 'skill', 'web_search', 'web_fetch']) {
      const profile = sharedToolProfile(name)
      if (profile === undefined) throw new Error(`no profile for ${name}`)
      expect(profile.noFileEffect).toBe(true)
      const args = { value: name }
      const call = profile.call(args)
      expect(call?.paths).toEqual([])
      expect(call?.rewrite([])).toBe(args)
    }
  })

  it('describes one call for the guard from the tool’s own arguments', () => {
    expect(describeSharedTool('read', { file_path: 'a.ts' })).toEqual({ paths: ['a.ts'], noFileEffect: false })
    expect(describeSharedTool('glob', { pattern: 'x' })).toEqual({ paths: [], noFileEffect: false })
    expect(describeSharedTool('grep', { pattern: 'x', path: 'src' })).toEqual({ paths: ['src'], noFileEffect: false })
    expect(describeSharedTool('todo_write', undefined)).toEqual({ paths: [], noFileEffect: true })
    expect(describeSharedTool('read', 'not a record')).toEqual({ paths: undefined, noFileEffect: false })
    expect(describeSharedTool('read', {})).toEqual({ paths: undefined, noFileEffect: false })
    expect(describeSharedTool('bash', { command: 'ls' })).toEqual({ paths: undefined, noFileEffect: false })
  })

  it('substitutes the workspace only where the tool searches it by default', () => {
    expect(withDefaultSearchRoot({ paths: [], noFileEffect: false }, 'glob', '/granted'))
      .toEqual({ paths: ['/granted'], noFileEffect: false })
    expect(withDefaultSearchRoot({ paths: [], noFileEffect: false }, 'grep', '/granted'))
      .toEqual({ paths: ['/granted'], noFileEffect: false })
    // A named root is already the path the replacement checks.
    expect(withDefaultSearchRoot({ paths: ['src'], noFileEffect: false }, 'glob', '/granted'))
      .toEqual({ paths: ['src'], noFileEffect: false })
    // Undefined stays undefined: the arguments name no path this host can establish.
    expect(withDefaultSearchRoot({ paths: undefined, noFileEffect: false }, 'glob', '/granted'))
      .toEqual({ paths: undefined, noFileEffect: false })
    // A tool that does not default to the workspace keeps its empty set, which the guard refuses.
    expect(withDefaultSearchRoot({ paths: [], noFileEffect: false }, 'read', '/granted'))
      .toEqual({ paths: [], noFileEffect: false })
    expect(withDefaultSearchRoot({ paths: [], noFileEffect: true }, 'todo_write', '/granted'))
      .toEqual({ paths: [], noFileEffect: true })
    expect(withDefaultSearchRoot({ paths: [], noFileEffect: false }, 'bash', '/granted'))
      .toEqual({ paths: [], noFileEffect: false })
  })
})
