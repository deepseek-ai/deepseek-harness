// Public ScreenCaptureKit capture with one completion and no blocking wait on the main actor.
import Foundation
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct CapturedPNG: Sendable { let bytes: Data; let width: Int; let height: Int }

private final class CaptureCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<CapturedPNG, any Error>?
    private var result: Result<CapturedPNG, NativeFailure>?
    private var cancelled = false
    var isCancelled: Bool { lock.withLock { cancelled } }

    func install(_ continuation: CheckedContinuation<CapturedPNG, any Error>) {
        let result: Result<CapturedPNG, NativeFailure>? = lock.withLock {
            if let result = self.result { return result }
            self.continuation = continuation
            return nil
        }
        if let result { Self.resume(continuation, result) }
    }
    func finish(_ result: Result<CapturedPNG, NativeFailure>) {
        let pending: CheckedContinuation<CapturedPNG, any Error>? = lock.withLock {
            guard self.result == nil else { return nil }
            self.result = result
            let pending = continuation
            continuation = nil
            return pending
        }
        if let pending { Self.resume(pending, result) }
    }
    func cancel() {
        lock.withLock { cancelled = true }
        finish(.failure(NativeFailure(code: "NATIVE_CANCELLED", message: "Capture cancelled; late frames are discarded")))
    }
    private static func resume(_ continuation: CheckedContinuation<CapturedPNG, any Error>, _ result: Result<CapturedPNG, NativeFailure>) {
        switch result { case .success(let image): continuation.resume(returning: image); case .failure(let error): continuation.resume(throwing: error) }
    }
}

typealias SystemCaptureOperation = @Sendable (CaptureTarget, CancellationLatch, ScreenshotTrace?,
    @escaping @Sendable () -> Bool, @escaping @Sendable (Result<CapturedPNG, NativeFailure>) -> Void) -> Void

final class WindowCapture: @unchecked Sendable {
    private static let encoder = DispatchQueue(label: "dsh.cua.png")
    private let start: SystemCaptureOperation
    private let lock = NSLock()
    private var active: UUID?

    init() { start = Self.startSystemCapture }
    init(start: @escaping SystemCaptureOperation) { self.start = start }

    func requireAvailable() throws {
        if lock.withLock({ active != nil }) { throw Self.busy() }
    }

    func capture(_ target: CaptureTarget, cancellation: CancellationLatch, trace: ScreenshotTrace? = nil) async throws -> CapturedPNG {
        let token = UUID()
        guard lock.withLock({
            guard active == nil else { return false }
            active = token
            return true
        }) else { throw Self.busy() }
        let completion = CaptureCompletion()
        let finish: @Sendable (Result<CapturedPNG, NativeFailure>) -> Void = { [self] result in
            lock.withLock { if active == token { active = nil } }
            completion.finish(result)
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                completion.install(continuation)
                do { try cancellation.check() }
                catch { finish(.failure(Self.cancelled())); return }
                if completion.isCancelled { finish(.failure(Self.cancelled())); return }
                start(target, cancellation, trace, { completion.isCancelled }, finish)
            }
        } onCancel: {
            trace?.mark("capture.cancelled")
            // The caller returns now, but the slot belongs to the outstanding system callback.
            completion.cancel()
        }
    }
    private static func startSystemCapture(_ target: CaptureTarget, _ cancellation: CancellationLatch,
        _ trace: ScreenshotTrace?, _ isCancelled: @escaping @Sendable () -> Bool,
        _ finish: @escaping @Sendable (Result<CapturedPNG, NativeFailure>) -> Void) {
        trace?.mark("shareable-content.begin")
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
            trace?.mark("shareable-content.end")
            if isCancelled() { finish(.failure(Self.cancelled())); return }
            guard let content else { finish(.failure(Self.captureFailure(error))); return }
            guard let window = content.windows.first(where: { $0.windowID == target.window.windowID && $0.owningApplication?.processID == target.process.pid }) else {
                finish(.failure(NativeFailure(code: "WINDOW_UNAVAILABLE", message: "Selected window is not available for capture"))); return
            }
            do { try cancellation.check(); try NativePlatform.verify(target.process) }
            catch let error as NativeFailure { finish(.failure(error)); return }
            catch { finish(.failure(Self.captureFailure(error))); return }
            trace?.mark("capture-config.begin")
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let expected = target.window.bounds
            guard window.frame.origin.x == expected.x, window.frame.origin.y == expected.y,
                  window.frame.width == expected.width, window.frame.height == expected.height,
                  filter.contentRect.width == expected.width, filter.contentRect.height == expected.height else {
                finish(.failure(NativeFailure(code: "WINDOW_CHANGED", message: "Capture surface does not match the selected window point geometry"))); return
            }
            let configuration = SCStreamConfiguration()
            let scale = Double(filter.pointPixelScale)
            let width = (filter.contentRect.width * scale).rounded(.up)
            let height = (filter.contentRect.height * scale).rounded(.up)
            guard let pixelsWide = Int(exactly: width), let pixelsHigh = Int(exactly: height), pixelsWide > 0, pixelsHigh > 0 else {
                finish(.failure(NativeFailure(code: "NATIVE_ERROR", message: "Capture reported invalid pixel dimensions"))); return
            }
            configuration.width = pixelsWide
            configuration.height = pixelsHigh
            configuration.showsCursor = false
            configuration.ignoreShadowsSingleWindow = true
            configuration.ignoreGlobalClipSingleWindow = true
            trace?.mark("capture-config.end")
            trace?.mark("capture-image.begin")
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
                trace?.mark("capture-image.end")
                if isCancelled() { finish(.failure(Self.cancelled())); return }
                guard let image else { finish(.failure(Self.captureFailure(error))); return }
                guard image.width == pixelsWide, image.height == pixelsHigh else {
                    finish(.failure(NativeFailure(code: "WINDOW_CHANGED", message: "Capture pixel dimensions changed from the selected window geometry"))); return
                }
                trace?.mark("png-encode.queued")
                encoder.async {
                    do {
                        if isCancelled() { finish(.failure(Self.cancelled())); return }
                        try cancellation.check()
                        trace?.mark("png-encode.begin")
                        let png = try autoreleasepool { try Self.encode(image) }
                        trace?.mark("png-encode.end")
                        if isCancelled() { finish(.failure(Self.cancelled())); return }
                        try cancellation.check()
                        finish(.success(png))
                    } catch let error as NativeFailure { finish(.failure(error)) }
                    catch { finish(.failure(Self.captureFailure(error))) }
                }
            }
        }
    }
    private static func cancelled() -> NativeFailure {
        NativeFailure(code: "NATIVE_CANCELLED", message: "Capture cancelled; late frames are discarded")
    }
    private static func busy() -> NativeFailure {
        NativeFailure(code: "CAPTURE_BUSY", message: "A previous system capture is still pending; other native operations remain available")
    }
    private static func encode(_ image: CGImage) throws -> CapturedPNG {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 1, nil) else {
            throw NativeFailure(code: "NATIVE_ERROR", message: "Cannot create PNG encoder")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw NativeFailure(code: "NATIVE_ERROR", message: "PNG encoding failed") }
        return CapturedPNG(bytes: Data(referencing: data), width: image.width, height: image.height)
    }
    private static func captureFailure(_ error: (any Error)?) -> NativeFailure {
        NativeFailure(code: CGPreflightScreenCaptureAccess() ? "NATIVE_ERROR" : "PERMISSION_DENIED",
                      message: error?.localizedDescription ?? "Window capture failed without an image")
    }
}
