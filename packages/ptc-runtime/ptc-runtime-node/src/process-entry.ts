/** Private built Node-runtime child entry; source execution calls runNodeMain directly. */
import { openInheritedControlChannel } from '@deepseek-ai/dsh-subprocess/control'
import { runNodeMain } from './process.ts'

void runNodeMain(openInheritedControlChannel(), Number(process.argv[2]), process)
