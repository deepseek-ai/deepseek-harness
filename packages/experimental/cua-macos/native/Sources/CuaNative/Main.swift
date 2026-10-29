// Server mode owns the AppKit event loop; launchers use NSWorkspace and clients use the service socket.
import AppKit
import Foundation
import Darwin
import Dispatch

@main enum CuaNativeMain {
    @MainActor static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.first == "--serve" {
            do {
                let options = try SharedHelperOptions(arguments: arguments)
                do {
                    let app = NSApplication.shared
                    app.setActivationPolicy(.prohibited)
                    guard let server = try SharedHelperServer(options: options) else { return }
                    try server.start()
                    withExtendedLifetime(server) { app.run() }
                } catch {
                    do { try options.recordStartupFailure(error) }
                    catch { fputs("dsh-cua-native: could not record startup failure: \(error)\n", stderr) }
                    fail(error)
                }
            } catch { fail(error) }
            return
        }
        Task { @MainActor in
            do {
                if arguments.first == "--ensure-shared" {
                    try await SharedHelperLauncher.ensure(SharedHelperOptions(arguments: arguments))
                } else {
                    try await SharedHelperProxy.run(configuration: HelperConfiguration(arguments: arguments))
                }
                exit(0)
            } catch { fail(error) }
        }
        dispatchMain()
    }

    private static func fail(_ error: Error) -> Never {
        let diagnostic = (error as? NativeFailure)?.message ?? error.localizedDescription
        do {
            let failure = JSONValue.object(["type": .string("error"), "code": .string((error as? NativeFailure)?.code ?? "NATIVE_STARTUP"),
                                            "message": .string(diagnostic)])
            if let data = try? JSONEncoder().encode(failure) { try? FileHandle.standardOutput.write(contentsOf: data + Data([10])) }
        }
        if let data = "dsh-cua-native: \(diagnostic)\n".data(using: .utf8) { try? FileHandle.standardError.write(contentsOf: data) }
        exit(1)
    }
}
