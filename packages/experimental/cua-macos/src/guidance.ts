/** Platform guidance appended to the shared application/window instructions. */
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'

/** Platform-specific access and input behavior. */
export const PLATFORM_GUIDANCE = `macOS: getApp also accepts bundle IDs and .app paths. findApps searches /Applications, /System/Applications and ~/Applications. Accessibility and Screen Recording permissions belong to the responsible launching application. Use the Computer Use permission page to request access, open System Settings, and check again. Native window and AX bounds use macOS points. show does not switch Spaces. Stage Manager can present reduced window geometry; explain any required foreground step before activate or raise.

Hover first uses advertised AX alternate UI without moving the system cursor, preserving revealed descendants until the pointer target leaves their region. The system-pointer fallback requires the target point to be unobscured in the foreground app. FOREGROUND_REQUIRED requires explicit activation or raising and a fresh observation before retrying.

Paste delivers plain text or HTML through the application's enabled standard Paste menu command. Paste follows the target app's focused text input. Foreground requirements vary by application; for example, ChatGPT/Codex was observed to accept background Paste without reading clipboard data. PASTE_NOT_CONSUMED means the command was dispatched but no clipboard read was observed before the configured deadline. Inspect the target contents, explicitly activate the app and focus the intended input, then observe again before deciding whether to retry; a delayed paste may still run.`

/** Complete model instructions for this provider. */
export const GUIDANCE = `${COMMON_GUIDANCE}

${PLATFORM_GUIDANCE}`
