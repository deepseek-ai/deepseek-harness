/** Command-line entry: run the generator with the process arguments and exit with its status. */
import { main } from './cli.ts'

process.exitCode = await main(process.argv.slice(2))
