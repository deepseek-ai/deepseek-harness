// An owned GUI launcher with no windows; its child outlives the launch application.
import AppKit
import Foundation
import Darwin

@MainActor final class Launcher: NSObject, NSApplicationDelegate {
    private let child = Process()
    func applicationDidFinishLaunching(_ notification: Notification) {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard let executable = arguments.first else { exit(64) }
        child.executableURL = URL(fileURLWithPath: executable)
        child.arguments = Array(arguments.dropFirst())
        child.standardOutput = FileHandle.standardOutput
        child.standardError = FileHandle.standardError
        child.terminationHandler = { @Sendable process in exit(process.terminationStatus) }
        do { try child.run() }
        catch { fputs("Launching fixture child failed: \(error)\n", stderr); exit(1) }
    }
}

@main enum LauncherMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let launcher = Launcher()
        app.delegate = launcher
        withExtendedLifetime(launcher) { app.run() }
    }
}
