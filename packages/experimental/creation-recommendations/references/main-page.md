# Standalone main-area page

Use this location for a global feature opened from the left sidebar. The page replaces the conversation area and does not render Chat/Trajectory tabs. Inspect the `main` slot and Client `layout` service; register a uniquely keyed panel through `ctx.slots.inject`. Keep the existing app frame. A separate HTML file, iframe, or replacement app root is not a mounted page.

Provide a left-sidebar entry using `sidebar-entry.md` beside this file and the layout service's panel navigation. A page and its launcher are separate registrations: a successful panel registration alone does not prove that the user can open it. Use the app's return/close navigation so the original conversation remains reachable.

Read `references/practices.md` from the `cordis-plugin-development` skill for theme, controls and state. Preserve persistent feature data separately from whether the panel is visible. Scope effects and locale registrations to the plugin lifetime. On disposal, use the current layout service to leave the panel only if this plugin owns the selected panel; never reset a different selected page. Verify open, return to conversation, reopen, persistence and removal in the live UI when available.
