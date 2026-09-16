// @vitest-environment jsdom
/** DOM cursor contrast without writing escape sequences or replacing the palette. */
import { expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { observeTerminalCursor } from '../src/client/terminal-cursor.ts'

it('tracks actual cell backgrounds and restores the cursor marker after measuring', () => {
  let update: () => void = () => {}
  const dispose = vi.fn()
  const terminal = { onRender: (listener: () => void) => { update = listener; return { dispose } } } as unknown as Terminal
  const node = document.createElement('div')
  node.innerHTML = '<div class="xterm-scrollable-element" style="background: white"><span class="xterm-cursor" style="color: cyan"></span></div>'
  document.body.append(node)
  try {
    const cursor = node.querySelector<HTMLElement>('span')!
    let preferred = 'rgb(0, 0, 0)'
    const listener = observeTerminalCursor(terminal, node, () => preferred)
    update()
    expect(node.style.getPropertyValue('--terminal-cursor')).toBe('rgb(0, 0, 0)')
    expect(node.style.getPropertyValue('--terminal-cursor-accent')).toBe('#ffffff')
    cursor.style.backgroundColor = '#000000'
    update()
    expect(node.style.getPropertyValue('--terminal-cursor')).toBe('#ffffff')
    expect(node.style.getPropertyValue('--terminal-cursor-accent')).toBe('#000000')
    expect(node.style.getPropertyValue('--terminal-cursor-cell-background')).toBe('rgb(0, 0, 0)')
    expect(node.style.getPropertyValue('--terminal-cursor-cell-foreground')).toBe('rgb(0, 255, 255)')
    preferred = 'rgba(255, 255, 255, 0)'
    update()
    expect(node.style.getPropertyValue('--terminal-cursor')).toBe('#ffffff')
    preferred = '#00ff00'
    update()
    expect(node.style.getPropertyValue('--terminal-cursor')).toBe('#00ff00')
    preferred = '#ffffff'
    cursor.style.backgroundColor = '#ffffff'
    update()
    expect(node.style.getPropertyValue('--terminal-cursor')).toBe('#000000')
    cursor.style.backgroundColor = 'rgba(0, 153, 0, 0.5)'
    update()
    expect(node.style.getPropertyValue('--terminal-cursor')).toBe('#000000')
    expect(node.style.getPropertyValue('--terminal-cursor-cell-background')).toBe('rgb(128, 204, 128)')
    preferred = '#000000'
    cursor.style.backgroundColor = '#888888'
    update()
    expect(node.style.getPropertyValue('--terminal-cursor')).toBe('#000000')
    expect(cursor.classList.contains('xterm-cursor')).toBe(true)
    cursor.remove()
    update()
    listener.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  } finally { node.remove() }
})
