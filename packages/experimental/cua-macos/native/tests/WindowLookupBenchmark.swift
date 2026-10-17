// Compile with native/Sources/CuaNative/*.swift except Main.swift; measures the production ownership lookup.
import AppKit
import Darwin
import Foundation

@main enum WindowLookupBenchmark {
    static func residentBytes() -> UInt64 {
        var info = mach_task_basic_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout.size(ofValue: info) / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        precondition(result == KERN_SUCCESS)
        return info.resident_size
    }

    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 8, height: 8),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.orderBack(nil)
        defer { window.close() }
        let id = UInt32(window.windowNumber)
        let windowCount = NativePlatform.windows(allLayers: true).count
        for _ in 0..<20 { precondition(ExternalInputMonitor.windowOwner(id) == getpid()) }
        let baseline = residentBytes()
        let start = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<1000 {
            autoreleasepool { precondition(ExternalInputMonitor.windowOwner(id) == getpid()) }
        }
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
        var usage = rusage()
        precondition(getrusage(RUSAGE_SELF, &usage) == 0)
        print("windows=\(windowCount) iterations=1000 elapsedMs=\(elapsed) baselineRSS=\(baseline) finalRSS=\(residentBytes()) peakRSS=\(usage.ru_maxrss)")
    }
}
