/** Link the downloaded platform artifact for dependency-free ABI tests. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packages = fileURLToPath(new URL('../packages/', import.meta.url));
const platform = `${process.platform}-${process.arch}`;
const parent = path.join(packages, 'entry/node_modules/@deepseek-ai');
fs.mkdirSync(parent, { recursive: true });
fs.symlinkSync(path.join(packages, platform), path.join(parent, `node-addon-system-${platform}`), 'junction');
