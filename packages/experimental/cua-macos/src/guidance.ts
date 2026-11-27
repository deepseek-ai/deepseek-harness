/** Platform setup guidance prefixed to the shared application and window instructions. */
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'

/** macOS operation levels, permissions, selectors, and native measurement units. */
export const PLATFORM_GUIDANCE = 'macOS: accessibility tree operations are available at app or window level. Simulated keyboard input is available at app level. Simulated mouse input is available at window level. pressKey, click, and drag accept command, control (or ctrl), option (or alt), shift, and fn. pressKey also accepts cmd for command. For pointer input on a sheet, select its window ID with app.getWindow(id). For menu items outside a window, use app.invoke(id). findApps searches /Applications, /System/Applications, and ~/Applications. Use the Computer Use permission page to grant the helper application Accessibility and Screen Recording permissions in System Settings. Native window and AX bounds use macOS points, while delivered screenshots carry their own pixel dimensions. show does not switch Spaces, and Stage Manager can present reduced window geometry; explain any required foreground step before calling app.activate() or performing an advertised AXRaise action.'

function operationGuidance(treeAdvice: string): string {
  const mouseGuidance = 'Leave useSystemInput unset for ordinary mouseMove, toggleMouse, click, drag, pressKey, and sendKeyEvent calls, even after approval. Prefer selectText for a supported text range and ordinary window-directed drag for a draggable control. If the effect is unclear, inspect the window before choosing another action. Request system input only when the user explicitly asks for it or the intended effect requires it.'
  const catalog = COMMON_GUIDANCE.replace(/^CuaAppInfo = .*$/m,
    '$& On macOS, identity comes from the canonical application bundle path. For installations sharing an id, pass their non-null identity unchanged to cua.getApp. To select a specific running instance, pass String(pid); instances of the same installation can share both id and identity. Running records include a pid; stopped records omit it.')
    .replace('## Simulated mouse\n', `## Simulated mouse\n${mouseGuidance}\n\n`)
  const methodDetails = new Map<string, string>([
    ['app.show', 'If a window is already visible, no action is taken. Otherwise restore a minimized window or ask the running app to reopen once. The resulting window ID may be new. With Stage Manager, show can add a window from the strip to the active group. A thumbnail alone does not count as displayed.'],
    ['window.show', 'If the selected window was closed, call app.show() and use the returned windowId. Use app.activate() to keep the app in front.'],
    ['cua.listApps', 'Each row represents one running process.'],
    ['cua.findApps', 'Each row represents an installation.'],
    ['sendKeyEvent', "For example W down, D down, D up, W up. A repeated 'down' for an ordinary held key sends one repeat without adding another hold. System down requires the selected foreground app; use the same useSystemInput value for explicit key up."],
    ['getAccessibilityTree', `Pass showDiff: true for a numbered tree, then apply edits in order: ~ updates a row, + inserts one, > moves its subtree. The position suffix ^P means first child of P (^root for the first root); >S means after sibling S. Unanchored + rows continue an insertion by indentation (first child or next sibling). Remove the listed IDs last. Use current actionable IDs for input. Omit showDiff or pass false for a full tree. macOS accepts maxElements up to 100000 and maxDepth up to 512. If the tree is truncated, select a narrower window or raise the reported limit on the next read. ${treeAdvice} Use element ids from the file only while that observation is current.`],
    ['mouseMove', 'With useSystemInput omitted or false, macOS uses accessibility hover without asking for mouse control. This requires both AXShowAlternateUI and AXShowDefaultUI on an enabled element or ancestor. Without that route, HOVER_UNAVAILABLE is returned before sending input. Physical movement requires an unobscured foreground target. Explain any necessary activation and observe the target again.'],
    ['toggleMouse', 'Press over the selected foreground window. By default the window receives the events, even a release outside it, and the system button stays up. Pass useSystemInput: true on each down to hold multiple system buttons in the same window. Up uses the route and window saved for that button. Physical moves can then drag, including your own mouse movements.'],
    ['pressKey', 'System input requires the selected foreground application and sends modifiers and the main key through the system keyboard queue, then releases them in reverse order.'],
    ['drag', 'Omitting useSystemInput or passing false directs the drag to the window without asking for mouse control. System input requires an unobscured foreground target, presses the requested keyboard modifiers, and releases the mouse button before those modifiers, including on cancellation.'],
    ['click', 'click is a Window method: select a window with const win = await app.getWindow(windowId), then call win.click(target). For a background control’s default action, use app.invoke(id). For a mouse click on a background app, call app.activate() first and re-read the target. Both target forms send mouse-down and mouse-up events. click(id) uses the center of the full element bounds. If that center is outside the window, take a fresh win.getScreenshot() and use click([x, y]) on a visible part of the control in screenshot pixels. A background app can ignore the events even when dispatched is true. With useSystemInput: true, the system pointer moves to the target and keyboard modifiers are pressed around the click, including release on cancellation. Verify the expected effect before typing or retrying.'],
  ])
  return `${PLATFORM_GUIDANCE}

${catalog.replace(/^- ([\w.]+)\(.*$/gm, (entry, method: string) => {
  const detail = methodDetails.get(method)
  return detail ? `${entry} ${detail}` : entry
})}`
}

const instructions = {
  raw: operationGuidance('In persistent PTC, capture a large tree with const tree = await win.getAccessibilityTree(). Filter its lines in memory, or save it with await tools.write({ file_path: path, content: tree }) to a new workspace file. Search its contents with tools.grep({ path, pattern }) and use tools.read around a matching line. Use inspect to display the matches you need.'),
  standalone: operationGuidance('Capture a large tree with const tree = await win.getAccessibilityTree(). Filter its lines in memory and use inspect to display the matches you need. If needed, save it to a new workspace file with node:fs/promises and use the session’s file tools to search it.'),
}
const activityGuidance = 'Recent activity notices identify when another agent or external input was last detected on a window you observed. You may continue using the window. Recheck its state if your next action depends on what you saw.'

/**
 * Select operation guidance for the current macOS configuration.
 * @param kind - Program environment receiving the instructions.
 * @param activityEnabled - Whether this connection reports recent activity.
 * @returns Model-facing instructions for the configured operations.
 */
export function macosGuidance(kind: 'raw' | 'standalone', activityEnabled: boolean): string {
  return activityEnabled ? `${instructions[kind]}\n\n${activityGuidance}` : instructions[kind]
}

/** Native PTC operation instructions for the default configuration. */
export const GUIDANCE = macosGuidance('raw', true)

/** Standalone program instructions for the default configuration. */
export const PROGRAM_GUIDANCE = macosGuidance('standalone', true)
