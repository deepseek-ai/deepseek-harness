/** Fixed artwork choices for the official home whale. */

/** Visual parameters shared by the dot and code fills. */
export interface WhaleArtwork {
  /** Maximum fill opacity, multiplied by each frame's water and highlight attenuation. */
  activeOpacity: number
  /** Word size in CSS pixels. */
  fontSize: number
  /** Authored artwork content, drawn verbatim as complete terms or sentences. */
  phrases: readonly string[]
  /** Maximum canvas redraw frequency. */
  frameRate: number
  /** One click's total lifetime in milliseconds. */
  rippleDurationMs: number
}

/** The official artwork; these values are part of the design, not deployment settings. */
export const WHALE_ARTWORK: WhaleArtwork = {
  activeOpacity: 0.65,
  fontSize: 7,
  phrases: [
    '// Everything is a plugin', 'ctx.plugin(Agent)', 'await agent.run()',
    'ctx.on("turn/end", next)', 'const tools = ctx.tools', 'await session.append(event)',
    'return next()', 'ctx.effect(() => dispose)', 'const { skills } = ctx',
    'yield tool.result', 'type Context = Harness', 'MCP.connect()',
    'useSession()', 'const workspace = cwd', 'await runtime.start()', '// Creator Mode',
  ],
  frameRate: 24,
  rippleDurationMs: 5700,
}
