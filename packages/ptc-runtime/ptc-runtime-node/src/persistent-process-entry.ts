/** Private built entry for retained Node evaluations. */
import { openInheritedControlChannel } from '@deepseek-ai/dsh-subprocess/control'
import { runPersistentMain } from './persistent-process.ts'

void runPersistentMain(openInheritedControlChannel(), Number(process.argv[2]), process)
