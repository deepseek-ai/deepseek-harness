/** Wire audio validation rejects malformed headers and inconsistent duration. */
import { expect, it } from 'vitest'
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'

function wave(): Buffer {
  const bytes = Buffer.alloc(44 + 32000)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32000, 40)
  return bytes
}

it('accepts complete PCM audio and rejects duration beyond the caller limit', () => {
  expect(validateWave(wave(), 1)).toBe(1)
  expect(() => validateWave(wave(), 0.9)).toThrow('exceeds')
})

it('rejects each inconsistent RIFF field and truncated recordings', () => {
  expect(() => validateWave(new Uint8Array(), 2)).toThrow('canonical')
  for (const offset of [0, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 4, 40]) {
    const bytes = wave(); bytes[offset] = bytes[offset]! ^ 1
    expect(() => validateWave(bytes, 2)).toThrow('canonical')
  }
  const odd = Buffer.concat([wave(), Buffer.alloc(1)])
  odd.writeUInt32LE(odd.length - 8, 4); odd.writeUInt32LE(odd.length - 44, 40)
  expect(() => validateWave(odd, 2)).toThrow('canonical')
})
