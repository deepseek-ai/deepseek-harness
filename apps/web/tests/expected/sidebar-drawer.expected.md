390px: closed sidebar has no rail; main width 390px
open: main geometry retained; background inert; no resize handle
close: Session navigation, Plugins navigation, mask and Escape
retained: sidebar DOM and opener focus
768px: 56px rail; main width 712px; drawer focus transfers to the rail toggle
breakpoint motion: collapsed rail hides immediately and returns compact without crossfades; expanded sidebar and explicit toggles retain their slides
767px: hidden drawer; main width 767px; no page overflow
global panels: browser top inset 48px; macOS keeps its existing clearance
tooltips: sidebar and workspace controls escape the drawer and fit the viewport
search input: 16px on touch; 13px with a fine pointer
simulated keyboard: homepage and drawer retain 844px layout height without following the 360px visual viewport; Settings stays within the viewport
keyboard close: layout height stays 844px; sidebar search retained; Settings close remains reachable
shell coverage: drawer backing and mask cover 844px without synthetic safe-area insets
rotation: 844x390 then 390x844 restores shell height and sidebar breakpoint
folded landscape: 951px frame splits at 475.5px without a resize handle; unfolding restores 280px and search focus; portrait retains the drawer
fold transitions: sidebar controls follow the divider in both directions; reduced motion changes width without animation
drawer mask: opacity transitions from 0 to 1 on open and 1 to 0 on close
reduced motion: drawer and mask settle without transitions
Web header: only the sidebar opener remains, with 48px leading clearance
below 768px: plugin and automation pages use 20px insets; Web view tabs align at 20px, while Desktop and wider Web tabs retain 28px
touch selected Session: More remains visible; update time is hidden; pinned rows offer Unpin before More with Workspace action spacing
touch Workspace: actions appear only while expanded, including after folding the focused row
fine pointer: folded Workspace actions remain available on hover
fine pointer: selected Session actions stay hidden until hover, including at 390px
