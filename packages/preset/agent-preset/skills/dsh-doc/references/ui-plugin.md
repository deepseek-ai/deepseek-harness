# UI plugins in the Web page

Read `templates/decoration/` with the file-read tool and write its files into your bundle directory: its `package.json` adds a `dsh.client` section (`platform`, `immediately`, `inject`) and a `./client` export beside the bundle patch.

`index.js` exports `export function apply() {}`; the patch inserts one row named after the package. For a simple drawing, prefer a slot with allocated space, such as `conversation.composer.dock` when available. Keep the first version within that slot's flow; do not plan a motion path around host controls. Use `shell.overlay` only when the request needs an overlay and its placement is known.

## Client module

The browser artifact registers a lazy factory whose id equals the package name. React comes from the browser module table; no duplicate React installation, CDN script, or UMD search is needed. For compiled sources, use the deployment's Client build tooling to emit this format; declare non-baseline runtime imports in `dsh.client.external`.

`templates/decoration/client.js` registers a lazy factory into `conversation.composer.dock` through `ctx.slots.inject` and `ctx.slots.register`; follow the selected slot's props and options from `Slots.listSubTree` when you change the slot.

Keep factories free of side effects. Register styles, timers, listeners and other resources inside `apply` with `ctx.effect`/`ctx.on` and return their cleanup functions. Component-local styles can render as React elements so unmounting removes them. Verify disposal for resources you add. Inherit the host theme for containers and controls; artwork may use its own colors. A page or panel beyond a decoration follows the UI rules in `references/practices.md`. Route visible UI text through the Client locale service. Do not replace the app root or append a second application to `document.body`. Do not read another plugin's DOM, stylesheet, or component source to estimate placement; choose a slot that already allocates space.
