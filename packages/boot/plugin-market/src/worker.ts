/** Worker Thread entry that parses one fetched index body and posts the result to its parent. */
import { parentPort, workerData } from 'node:worker_threads'
import { parseIndexBody, type IndexParseRequest } from './parse.ts'

const request = workerData as Partial<IndexParseRequest> | null
if (!(request?.body instanceof Uint8Array) || typeof request.url !== 'string') throw new Error('index parser request is malformed')
parentPort?.postMessage(parseIndexBody(request.body, request.url))
