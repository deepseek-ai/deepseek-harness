/** Register an isolated protocol through the Electron version used by Desktop. */
const { app } = require('electron')
const [scheme, executable] = process.argv.slice(-2)
app.whenReady().then(() => app.exit(app.setAsDefaultProtocolClient(scheme, executable) ? 0 : 1))
