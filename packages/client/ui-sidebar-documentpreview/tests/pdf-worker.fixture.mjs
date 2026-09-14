/** Real worker-thread carrier for the installed PDF.js worker in the Node smoke. */
import { parentPort, workerData } from 'node:worker_threads'

const listeners = new Map()
const port = {
  postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
  addEventListener: (_type, listener) => {
    const forward = data => listener({ data })
    listeners.set(listener, forward)
    parentPort.on('message', forward)
  },
  removeEventListener: (_type, listener) => {
    const forward = listeners.get(listener)
    if (forward !== undefined) parentPort.off('message', forward)
    listeners.delete(listener)
  },
}
const { WorkerMessageHandler } = await import(workerData.workerUrl)
WorkerMessageHandler.initializeFromPort(port)
