/** Contrast-aware styling for xterm's DOM cursor, independent of its ANSI palette. */
import type { IDisposable, Terminal } from '@xterm/xterm'

/* oxlint-disable typescript/no-non-null-assertion -- The mounted xterm DOM supplies elements and sRGB channels. */

/**
 * Keep the cursor visible on default, indexed, true-color and inverse cell backgrounds.
 * @param terminal - opened DOM-rendered emulator.
 * @param node - screen root containing the emulator and scoped cursor CSS variables.
 * @param preferredCursor - current DSH or application cursor color.
 * @returns listener disposer; no terminal input or palette changes are emitted.
 */
export function observeTerminalCursor(terminal: Terminal, node: HTMLElement, preferredCursor: () => string): IDisposable {
  return terminal.onRender(() => {
    const cursor = node.querySelector<HTMLElement>('.xterm-cursor')
    if (cursor === null) return
    // Removing only the cursor marker exposes the cell's rendered colors, including reverse video.
    cursor.classList.remove('xterm-cursor')
    let background: string
    let foreground: string
    try {
      const style = getComputedStyle(cursor)
      foreground = style.color
      background = opaqueColor(style.backgroundColor, () => getComputedStyle(node.querySelector('.xterm-scrollable-element')!).backgroundColor)
    } finally { cursor.classList.add('xterm-cursor') }
    const preferred = opaqueColor(preferredCursor(), () => background)
    const backgroundLuminance = luminance(background)
    const preferredLuminance = luminance(preferred)
    // WCAG contrast is 3:1 for the cursor and 4.5:1 for the character inside it.
    const contrast = (Math.max(backgroundLuminance, preferredLuminance) + 0.05) / (Math.min(backgroundLuminance, preferredLuminance) + 0.05)
    const fill = contrast >= 3 ? preferred : backgroundLuminance > 0.179 ? '#000000' : '#ffffff'
    node.style.setProperty('--terminal-cursor', fill)
    node.style.setProperty('--terminal-cursor-accent', luminance(fill) > 0.179 ? '#000000' : '#ffffff')
    node.style.setProperty('--terminal-cursor-cell-background', background)
    node.style.setProperty('--terminal-cursor-cell-foreground', foreground)
  })
}

// xterm emits sRGB colors; OSC values are normalized to six-digit hex by TerminalTheme.
function luminance(color: string): number {
  const [r, g, b] = colorChannels(color).map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function colorChannels(color: string): number[] {
  return color.startsWith('#')
    ? [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)].map(value => Number.parseInt(value, 16))
    : color.match(/[\d.]+/gu)!.map(Number)
}

function opaqueColor(color: string, background: () => string): string {
  const channels = colorChannels(color)
  const alpha = channels[3] ?? 1
  if (alpha === 1) return color
  const surface = colorChannels(background())
  const rgb = channels.slice(0, 3).map((channel, index) => Math.round(channel * alpha + surface[index]! * (1 - alpha)))
  return `rgb(${rgb.join(', ')})`
}
