// Only server mode owns AppKit; launcher and stdio clients connect to its socket.
import AppKit
import Foundation
import Darwin

@main enum CuaNativeMain {
    @MainActor static func main() {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            if arguments.first == "--ensure-shared" {
                try SharedHelperLauncher.ensure(SharedHelperOptions(arguments: arguments))
                return
            }
            if arguments.first == "--serve" {
                guard setsid() >= 0 else { throw SharedSocket.failure("Creating shared helper session") }
                let options = try SharedHelperOptions(arguments: arguments)
                let app = NSApplication.shared
                app.setActivationPolicy(.prohibited)
                guard let server = try SharedHelperServer(options: options) else { return }
                try server.start()
                withExtendedLifetime(server) { app.run() }
                return
            }
            let configuration = try HelperConfiguration(arguments: arguments)
            try SharedHelperProxy.run(configuration: configuration)
        } catch {
            let diagnostic = (error as? NativeFailure)?.message ?? error.localizedDescription
            if CommandLine.arguments.dropFirst().first == "--serve" {
                let failure = JSONValue.object(["type": .string("error"), "code": .string((error as? NativeFailure)?.code ?? "NATIVE_STARTUP"),
                                                "message": .string(diagnostic)])
                if let data = try? JSONEncoder().encode(failure) { try? FileHandle.standardOutput.write(contentsOf: data + Data([10])) }
            }
            if let data = "dsh-cua-native: \(diagnostic)\n".data(using: .utf8) { try? FileHandle.standardError.write(contentsOf: data) }
            exit(1)
        }
    }
}
