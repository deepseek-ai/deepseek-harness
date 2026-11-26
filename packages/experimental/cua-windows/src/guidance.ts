/** Platform setup guidance prefixed to the shared application and window instructions. */
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'

/** Windows operation levels, application selectors, and input availability. */
export const PLATFORM_GUIDANCE = 'Windows: accessibility tree operations are available only at window level. Simulated mouse and keyboard input are available at window level. Supported modifiers: ctrl, alt, shift, win. control is an alias for ctrl. Key and mouse holds use desktop input. Keep the target in front while holding inputs. Release through the same window. After focus changes, an up releases desktop input without restoring focus; the original window may not receive that event.'

const methodDetails = new Map<string, string>([
  ['cua.listApps', 'Windows aggregates applications from eligible visible top-level windows in the current Windows session.'],
  ['cua.getApp', 'Pass an exact id from listApps or findApps, or an existing absolute .exe path. After consent, applications with isRunning: false are launched. Application windows may take a few seconds to appear after launch and may belong to a different application ID. Refresh getWindows after a short wait; use listApps or findApps to locate and select the owning application when needed, then choose its window.'],
  ['cua.findApps', 'Windows searches installed applications listed in StartApps. This list may be incomplete; if an application is not found, ask the user for its location. An absolute .exe path can also be queried directly.'],
  ['app.launch', 'A single-instance application may only activate its existing instance. The launched instance may be associated with a different application ID.'],
  ['getAccessibilityTree', 'Set the node count or depth for one read. Windows accepts maxElements from 1 to 10000 and maxDepth from 1 to 100. Omitted limits use the provider settings; maxDepth=1 includes only the window root. If the tree is truncated, select a narrower window or increase the relevant limit. includeMenus expands menu contents. Element IDs are UI Automation RuntimeIds formatted as slash-separated integer strings, such as "12/345/6". Pass the complete string unchanged as elementId. Each element lists all its supported patterns, not action names. Disabled is an observed state, not a prohibition on attempting an operation.'],
  ['listActions', 'Actions use case-sensitive Pattern.Action names, such as "Invoke.Invoke", "Toggle.Toggle", and "ExpandCollapse.Expand". Each pattern has a known set of native UI Automation operations. One pattern can expose multiple actions. Use a known operation of an advertised pattern directly; call listActions when you need to confirm the exposed operations. Query methods are not exposed through performAction.'],
  ['invoke', 'The provider chooses default action for well-known patterns. A failed operation is not retried through another pattern or simulated input.'],
  ['paste', 'Write text or HTML to the system clipboard and send Ctrl+V to the target window. The new clipboard contents remain in place. Return dispatch evidence, not confirmation that the target applied the content; observe the target before continuing. A failure is reported without substituting typeText.'],
  ['performAction', 'Use the exact Pattern.Action name. Omit argument or pass null for a parameter-free operation. Pass a single parameter as its direct JSON value; pass multiple parameters as an object using their native names. Enum values use their exact names as strings. Examples: await win.performAction(id, "Value.SetValue", "hello"); await win.performAction(id, "Window.SetWindowVisualState", "Normal"); await win.performAction(id, "Transform.Resize", { width: 800, height: 600 }).'],
])

/** Native operation instructions; the shared Host adds guidance for declared capabilities. */
export const GUIDANCE = `${PLATFORM_GUIDANCE}

${COMMON_GUIDANCE.replace(/^CuaAppInfo = .*$/m,
  '$& Windows application IDs are opaque selectors. Copy the returned id unchanged; do not construct an ID from an application name or executable. An executable hosting multiple applications requires a specific returned id. Windows records have identity: null.')
  .replace(/^- ([\w.]+)\(.*$/gm, (entry, method: string) => {
    const detail = methodDetails.get(method)
    if (!detail) return entry
    if (method === 'getAccessibilityTree' || method === 'paste') return `${entry.replace(/ — .*$/, '')} — ${detail}`
    return `${entry} ${detail}`
  })}`
