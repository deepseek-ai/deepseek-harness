// Exercise the production launcher against an application that exits or stalls before readiness.
import AppKit
import Foundation
import Darwin

// The fixture only supplies the launcher's two unrelated parameter/path dependencies.
enum RequestParameters {
    static func invalid(_ message: String) -> NativeFailure { NativeFailure(code: "INVALID_ARGUMENT", message: message) }
}
enum NativePlatform {
    static func executablePath(_ pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }
}

@main enum StartupFixture {
    @MainActor static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.first == "--serve" {
            let root = Bundle.main.bundleURL.deletingLastPathComponent()
            do {
                let app = NSApplication.shared
                app.setActivationPolicy(.prohibited)
                app.finishLaunching()
                try String(getpid()).write(to: root.appendingPathComponent("served.pid"), atomically: true, encoding: .utf8)
                let mode = try String(contentsOf: root.appendingPathComponent("mode"), encoding: .utf8)
                if mode == "exit" { _exit(42) }
                while true { pause() }
            } catch { exit(1) }
        }
        Task { @MainActor in
            do {
                try await SharedHelperLauncher.ensure(SharedHelperOptions(arguments: arguments))
                exit(0)
            } catch {
                let failure = error as? NativeFailure ?? NativeFailure(code: "NATIVE_STARTUP", message: error.localizedDescription)
                let data = try JSONEncoder().encode(JSONValue.object([
                    "type": .string("error"), "code": .string(failure.code), "message": .string(failure.message),
                ]))
                try FileHandle.standardOutput.write(contentsOf: data + Data([10]))
                exit(1)
            }
        }
        dispatchMain()
    }
}
