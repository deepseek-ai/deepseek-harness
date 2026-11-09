# Persist your own configuration

Plugin code never persists configuration by reading, filtering, and rewriting the active profile's `cordis.patch.yml`, and never locates that file by walking up from the package directory. That file is not your bundle's patch: it belongs to the user and holds other plugins' `insert` rows, comments, and `!!js` expressions. To change its own configuration after `apply` returns, a plugin uses the config editor:

```js
const entry = ctx.fiber.entry
const editor = ctx.get('configEditor')
if (entry === undefined || editor === undefined) throw new Error('Configuration cannot be saved in this profile')
await editor.edit(entry, current => ({ ...current, field: value }))
```

`change` returns the row's complete config. The editor keeps the rest of the file, validates the candidate, serializes the write with other profile changes, and rejects values that a higher layer overrides. Report a rejection or a missing editor to the user instead of claiming the value was saved. Editing an ordinary field restarts the plugin so `apply` rebuilds its state; a field declared `.volatile()` updates in place and is read with `config.field.get()`. Store secrets, such as a token from an in-app sign-in or binding flow, as `ctx.credentials.modifyRecord()` records, not configuration; declare `credentials` in `inject` or read it with `ctx.get('credentials')`, and see the `@deepseek-ai/dsh-credentials` README for record keys.
