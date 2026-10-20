/** Platform guidance appended to the shared application/window instructions. */
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'

/** Platform-specific access and input behavior. */
export const PLATFORM_GUIDANCE = `macOS: getApp also accepts bundle IDs and .app paths. Accessibility and Screen Recording permissions belong to the responsible launching application. Use the Computer Use permission page to request access, open System Settings, and check again. Paste uses the enabled standard Paste menu command and waits for clipboard data consumption. Stage Manager can present reduced window geometry; explain any required foreground step before activate or raise.

Hover first uses advertised AX alternate UI without moving the system cursor, preserving revealed descendants until the pointer target leaves their region. When unavailable, it moves the visible system cursor without pressing a button; that route requires the target point to be unobscured in the foreground app. FOREGROUND_REQUIRED requires explicit activation or raising and a fresh observation before retrying. Returning, AX reads and screenshots do not restore the previous point. Wait for the application's hover delay, observe, then hover into the revealed controls before clicking. Use successive hover calls for intermediate points. The result reports hoverRoute and systemPointerMoved. Other input or application changes can interrupt the interaction; app objects do not reserve applications between calls.

Paste delivers plain text or HTML through the application's enabled standard Paste menu command. Paste follows the target app's focused text input. Foreground requirements vary by application; for example, ChatGPT/Codex was observed to accept background Paste without reading clipboard data. PASTE_NOT_CONSUMED means the command was dispatched but no clipboard read was observed before the configured deadline. Inspect the target contents, explicitly activate the app and focus the intended input, then observe again before deciding whether to retry; a delayed paste may still run.

On macOS, click accepts optional holdMs: a nonnegative integer in milliseconds for each press, including double-click presses. Zero releases without an additional hold. The configured maximum is stated below. Explicit holdMs uses pointer input even for AX targets; omission preserves ordinary clicks. The operation deadline applies, and cancellation or timeout releases the button.

App and Window also expose hover(target: number | [x, y], options?: { relative?: boolean }) -> { dispatched, verified, hoverRoute, systemPointerMoved }. Coordinate targets must be [x, y]; a bare number is an AX element index.`

/** Complete model instructions for this provider. */
export const GUIDANCE = `${COMMON_GUIDANCE}

${PLATFORM_GUIDANCE}`
