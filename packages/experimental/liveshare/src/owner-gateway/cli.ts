/** Entry point for the owner gateway worker, launched by the host over an IPC channel. */

import { runGatewayWorker } from './worker.ts'

if (process.send === undefined) throw new Error('Liveshare gateway requires the owner worker IPC channel')
runGatewayWorker()
