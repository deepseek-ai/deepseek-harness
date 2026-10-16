// PID routing follows DSH's MIT-licensed Cua Driver adaptation.
// Swift SPI signatures reference Peekaboo's BackgroundInputDriver and WindowRoutedPointerDriver.
import CoreGraphics
import Darwin
import Dispatch

/// Event delivery owned by one serial input worker. Posting does not verify application receipt.
final class PIDEventPoster {
    private typealias PostToPID = @convention(c) (pid_t, CGEvent) -> Void
    private typealias SetWindowLocation = @convention(c) (CGEvent, CGFloat, CGFloat) -> Void
    private typealias SetIntegerField = @convention(c) (CGEvent, UInt32, Int64) -> Void

    private let library: UnsafeMutableRawPointer?
    private let postToPID: PostToPID?
    private let setWindowLocation: SetWindowLocation?
    private let setIntegerField: SetIntegerField?

    init() {
        let library = dlopen(
            "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
            RTLD_LAZY | RTLD_LOCAL
        )
        self.library = library
        if let symbol = Self.symbol("SLEventPostToPid", library: library) {
            self.postToPID = unsafeBitCast(symbol, to: PostToPID.self)
        } else {
            self.postToPID = nil
        }
        if let symbol = Self.symbol("CGEventSetWindowLocation", library: library) {
            self.setWindowLocation = unsafeBitCast(symbol, to: SetWindowLocation.self)
        } else {
            self.setWindowLocation = nil
        }
        if let symbol = Self.symbol("SLEventSetIntegerValueField", library: library) {
            self.setIntegerField = unsafeBitCast(symbol, to: SetIntegerField.self)
        } else {
            self.setIntegerField = nil
        }
    }

    deinit {
        if let library { dlclose(library) }
    }

    /// Send one event once, using public PID delivery only when the private posting symbol is absent.
    func post(_ event: CGEvent, to pid: Int32) {
        event.timestamp = DispatchTime.now().uptimeNanoseconds
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
        if let postToPID {
            postToPID(pid, event)
        } else {
            event.postToPid(pid)
        }
    }

    /// Set the destination window and local point before any part of its gesture is posted.
    func stampWindow(_ event: CGEvent, pid: Int32, windowID: UInt32, point: WindowPoint) throws {
        guard let setWindowLocation, let setIntegerField else {
            throw NativeFailure(
                code: "NATIVE_ERROR",
                message: "Window-local input routing is unavailable on this macOS version"
            )
        }
        setWindowLocation(event, CGFloat(point.x), CGFloat(point.y))
        setIntegerField(event, 40, Int64(pid))
        let windowFields: [UInt32] = [51, 91, 92]
        for field in windowFields {
            setIntegerField(event, field, Int64(windowID))
        }
    }

    /// Write the event fields used by the window-directed pointer protocol.
    func stamp(_ event: CGEvent, field: UInt32, value: Int64) throws {
        guard let setIntegerField else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Pointer event field routing is unavailable")
        }
        setIntegerField(event, field, value)
    }

    private static func symbol(_ name: String, library: UnsafeMutableRawPointer?) -> UnsafeMutableRawPointer? {
        if let library, let address = dlsym(library, name) { return address }
        // Darwin's RTLD_DEFAULT is the pseudo-handle -2, not an owned library handle.
        return dlsym(UnsafeMutableRawPointer(bitPattern: -2), name)
    }
}
