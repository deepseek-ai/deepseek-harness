/** Platform setup guidance prefixed to the shared application and window instructions. */
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'

/** macOS operation levels, permissions, selectors, and native measurement units. */
export const PLATFORM_GUIDANCE = 'macOS: accessibility tree operations are available at app or window level. Simulated keyboard input is available at app level. Simulated mouse input is available at window level. pressKey, click, and drag accept command, control (or ctrl), option (or alt), shift, and fn. pressKey also accepts cmd for command. For pointer input on a sheet, select its window ID with app.getWindow(id). For menu items outside a window, use app.invoke(id). findApps searches /Applications, /System/Applications, and ~/Applications. Use the Computer Use permission page to grant the helper application Accessibility and Screen Recording permissions in System Settings. Native window and AX bounds use macOS points, while delivered screenshots carry their own pixel dimensions. show does not switch Spaces, and Stage Manager can present reduced window geometry; explain any required foreground step before calling app.activate() or performing an advertised AXRaise action.'

function operationGuidance(treeAdvice: string): string {
  const mouseGuidance = 'Leave useSystemPointer unset for ordinary mouseMove and drag calls, even after approval. Prefer selectText for a supported text range and ordinary window-directed drag for a draggable control. If the effect is unclear, inspect the window before choosing another action. Request the system pointer only when the user explicitly asks for it or the intended effect requires it.'
  const catalog = COMMON_GUIDANCE.replace('## Simulated mouse\n', `## Simulated mouse\n${mouseGuidance}\n\n`)
  const methodDetails = new Map<string, string>([
    ['cua.listApps', 'Each row represents one running process. To select one of several instances with the same name or bundle ID, pass String(row.pid) to cua.getApp.'],
    ['cua.findApps', 'Running installation matches include their process ID. Stopped matches have no pid.'],
    ['sendKeyEvent', "Send 'down' to hold a key across tool calls in one program, for example W down, D down, D up, W up. Holding a key on a physical keyboard can produce repeated key-down events after a delay. To send one such repeat for a non-modifier key this run already holds, send 'down' again. Each call posts one event. A control can filter repeats. Use the app's response to decide whether and when to repeat or release the key. When this program returns, throws, or the user pauses it, macOS releases only its remaining keys at their original recipients."],
    ['getAccessibilityTree', `macOS accepts maxElements up to 100000 and maxDepth up to 512. If the tree is truncated, select a narrower window or raise the reported limit on the next read. ${treeAdvice} Use element ids from the file only while that observation is current.`],
    ['mouseMove', 'With useSystemPointer omitted or false, macOS uses accessibility hover without asking for mouse control. This requires both AXShowAlternateUI and AXShowDefaultUI on an enabled element or ancestor. Without that route, HOVER_UNAVAILABLE is returned before sending input. Physical movement requires an unobscured foreground target. Explain any necessary activation and observe the target again.'],
    ['drag', 'Omitting useSystemPointer or passing false directs the drag to the window without asking for mouse control. An explicit system drag shares the session decision with mouseMove and holds the chosen button along the path in the unobscured foreground window.'],
    ['click', 'click is a Window method: select a window with const win = await app.getWindow(windowId), then call win.click(target). For a background control’s default action, use app.invoke(id). For a mouse click on a background app, call app.activate() first and re-read the target. Both target forms send mouse-down and mouse-up events. click(id) uses the center of the full element bounds. If that center is outside the window, take a fresh win.getScreenshot() and use click([x, y]) on a visible part of the control in screenshot pixels. A background app can ignore the events even when dispatched is true. Verify the expected effect, such as a changed selection, before typing or retrying.'],
  ])
  return `${PLATFORM_GUIDANCE}

${catalog.replace(/^- ([\w.]+)\(.*$/gm, (entry, method: string) => {
  const detail = methodDetails.get(method)
  const signature = method === 'drag' ? entry.replace('relative?: boolean }', 'relative?: boolean, useSystemPointer?: boolean }') : entry
  return detail ? `${signature} ${detail}` : signature
})}`
}

/** Native PTC operation instructions with registered file tools for large observations. */
export const GUIDANCE = operationGuidance('In persistent PTC, capture a large tree with const tree = await win.getAccessibilityTree(). Filter its lines in memory, or save it with await tools.write({ file_path: path, content: tree }) to a new workspace file. Search its contents with tools.grep({ path, pattern }) and use tools.read around a matching line. Use inspect to display the matches you need.')

/** CUA-only program instructions; other session tools remain outside the program. */
export const PROGRAM_GUIDANCE = operationGuidance('Capture a large tree with const tree = await win.getAccessibilityTree(). Filter its lines in memory and use inspect to display the matches you need. If needed, save it to a new workspace file with node:fs/promises and use the session’s file tools to search it.')
