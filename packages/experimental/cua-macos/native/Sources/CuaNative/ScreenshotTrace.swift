// Screenshot phase records omit request contents, window titles and image data.
import Foundation
import Dispatch

struct ScreenshotTrace: Sendable {
    let requestID: String
    private let started = DispatchTime.now().uptimeNanoseconds
    private let report: (@Sendable (JSONValue) -> Void)?

    init(requestID: String, report: (@Sendable (JSONValue) -> Void)? = nil) { self.requestID = requestID; self.report = report }

    func encoded(_ stage: String, errorCode: String? = nil) throws -> Data {
        struct Entry: Encodable {
            let requestId: String
            let stage: String
            let elapsedMs: Double
            let errorCode: String?
        }
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
        let entry = Entry(requestId: requestID, stage: stage, elapsedMs: elapsed, errorCode: errorCode)
        var line = Data("[cua-screenshot] ".utf8)
        line.append(try JSONEncoder().encode(entry))
        line.append(10)
        return line
    }

    func diagnosticValue(_ stage: String, errorCode: String? = nil) -> JSONValue {
        var fields: [String: JSONValue] = [
            "type": .string("diagnostic"), "requestId": .string(requestID), "stage": .string(stage),
            "elapsedMs": .number(Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000),
        ]
        if let errorCode { fields["errorCode"] = .string(errorCode) }
        return .object(fields)
    }

    func mark(_ stage: String, errorCode: String? = nil) {
        if let report {
            report(diagnosticValue(stage, errorCode: errorCode))
            return
        }
        // A diagnostic failure must not replace the capture result or its original error.
        if let line = try? encoded(stage, errorCode: errorCode) {
            try? FileHandle.standardError.write(contentsOf: line)
        }
    }
}
