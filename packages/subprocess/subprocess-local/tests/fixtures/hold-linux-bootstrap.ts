/** Keep the launch request unconsumed until the parent terminates this OS fixture. */
process.stdin.resume()
process.stdout.write('BOOTSTRAP_WAITING\n')
