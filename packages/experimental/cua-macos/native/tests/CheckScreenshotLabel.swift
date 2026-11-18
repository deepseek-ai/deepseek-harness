// Verify a screenshot against an AX control using text recognized from the captured pixels.
import Foundation
import Vision

let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 6, let x = Double(args[2]), let y = Double(args[3]),
      let width = Double(args[4]), let height = Double(args[5]) else {
    fatalError("Expected PNG path, label and normalized top-left AX bounds")
}
let expected = CGRect(x: x, y: y, width: width, height: height)
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.automaticallyDetectsLanguage = true
try VNImageRequestHandler(url: URL(fileURLWithPath: args[0]), options: [:]).perform([request])
let matches = (request.results ?? []).filter { $0.topCandidates(1).first?.string.caseInsensitiveCompare(args[1]) == .orderedSame }
guard matches.contains(where: { expected.contains(CGPoint(x: $0.boundingBox.midX, y: 1 - $0.boundingBox.midY)) }) else {
    fputs("The screenshot does not show the control label inside its AX bounds.\n", stderr)
    exit(1)
}
