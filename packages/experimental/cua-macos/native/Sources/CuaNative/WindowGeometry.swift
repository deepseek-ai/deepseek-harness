// Compare independent window frames before capture or pointer delivery.
import CoreGraphics

enum WindowGeometry {
    static let conflictMessage = "Window display and accessibility bounds disagree. Read fresh state; if unchanged, use AX actions or explicitly restore the window before capture or coordinate input"

    /// Quartz and AppKit use opposite Y directions anchored to the primary display, including on other displays.
    static func appKitPoint(_ point: CGPoint, mainDisplayHeight: CGFloat) -> CGPoint {
        CGPoint(x: point.x, y: mainDisplayHeight - point.y)
    }

    /// Window-local coordinates survive movement, but require a fresh observation after resizing.
    static func validateObservedSize(observed: WindowBounds?, current: WindowBounds) throws {
        guard let observed else {
            throw NativeFailure(code: "STALE_SNAPSHOT", message: "Window has no observation; read getAXState or take a screenshot before coordinate input")
        }
        guard observed.width == current.width, observed.height == current.height else {
            throw NativeFailure(code: "WINDOW_CHANGED", message: "Window size changed since observation; read getAXState or take a screenshot before coordinate input")
        }
    }

    /// Read CG bounds around the AX query; missing AX geometry does not disable an owned window.
    static func resolve(
        owner: ProcessIdentity, windowID: UInt32,
        readWindow: (Int32, UInt32) throws -> WindowInfo = NativePlatform.ownedWindow,
        verifyOwner: (ProcessIdentity) throws -> Void = NativePlatform.verify,
        accessibilityBounds: () throws -> WindowBounds?
    ) throws -> WindowInfo {
        let before = try readWindow(owner.pid, windowID)
        let accessibility = try accessibilityBounds()
        try verifyOwner(owner)
        let after = try readWindow(owner.pid, windowID)
        try validate(before: before.bounds, after: after.bounds, accessibility: accessibility)
        return after
    }

    /// CG must stay unchanged during the read. Integral point rectangles absorb frame representation rounding.
    static func validate(before: WindowBounds, after: WindowBounds, accessibility: WindowBounds?) throws {
        guard before == after else {
            throw NativeFailure(code: "WINDOW_CHANGED", message: "Window moved or resized while checking geometry; read fresh state")
        }
        guard let accessibility, let ax = rectangle(accessibility), let cg = rectangle(after) else { return }
        guard ax.integral == cg.integral else {
            throw NativeFailure(code: "WINDOW_CHANGED", message: conflictMessage)
        }
    }

    private static func rectangle(_ bounds: WindowBounds) -> CGRect? {
        guard bounds.x.isFinite, bounds.y.isFinite, bounds.width.isFinite, bounds.height.isFinite,
              bounds.width > 0, bounds.height > 0,
              (bounds.x + bounds.width).isFinite, (bounds.y + bounds.height).isFinite else { return nil }
        return CGRect(x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height)
    }
}
