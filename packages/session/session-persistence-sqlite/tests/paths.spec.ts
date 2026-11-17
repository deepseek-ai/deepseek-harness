/** SQLite artifact paths preserve arbitrary Session identifiers. @module */
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { encodeSegment, projectKey, sessionDir } from '../src/paths.ts'

it('escapes unsafe identifiers and rejects empty path components', () => {
  expect(() => encodeSegment('')).toThrow('empty path segment')
  expect(encodeSegment('.')).toBe('~002E')
  expect(encodeSegment('..')).toBe('~002E~002E')
  expect(encodeSegment('a/~')).toBe('a~002F~007E')
  expect(encodeSegment('\ud800')).toBe('~D800')
  expect(() => projectKey('')).toThrow('empty project path')
  expect(projectKey('/')).toBe('--root--')
  expect(projectKey('/开发/~agent')).toBe('--~5F00~53D1-~007Eagent--')
  expect(projectKey('C:\\work\\agent')).toBe('--C-work-agent--')
  expect(sessionDir('/root', undefined, SessionId('id'))).toBe('/root/_no-cwd/id'.replaceAll('/', process.platform === 'win32' ? '\\' : '/'))
})
