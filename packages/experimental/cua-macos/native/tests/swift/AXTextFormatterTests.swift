// Pure disclosure fixtures exercise semantic retention without desktop state.
import Foundation
import Testing
@testable import CuaNative

private func node(_ role: String = "AXButton") -> AXTextNode {
    AXTextNode(index: 7, role: role, title: nil, value: nil, description: nil, actions: [], enabled: true,
               valueWritable: nil, selectionWritable: nil, selected: nil, selectedRange: nil, selectedText: nil)
}

@Test func distinguishesAnEmptyValueFromItsPlaceholderAndWritability() {
    var field = node("AXTextField")
    field.title = "Project"
    field.value = ""
    field.placeholder = "Name your project"
    field.valueWritable = true
    field.selectionWritable = false
    field.focused = true
    #expect(AXTextFormatter.line(field, level: 0) == "- [7] AXTextField focused valueWritable=true selectionWritable=false \"Project\" value=\"\" placeholder=\"Name your project\"")
    field.value = nil
    field.valueWritable = nil
    #expect(AXTextFormatter.line(field, level: 0).contains("valueWritable=unknown"))
    #expect(AXTextFormatter.line(field, level: 0).contains("value=unavailable"))
}

@Test func preservesWindowButtonSubrolesAndDisabledState() {
    var button = node()
    button.index = nil
    button.subrole = "AXZoomButton"
    button.enabled = false
    #expect(button.hasMeaning)
    #expect(AXTextFormatter.line(button, level: 0) == "- AXButton subrole=AXZoomButton disabled")
}

@Test func keepsSemanticContainersAndOnlyFlattensUnlabelledStructuralGroups() {
    for role in ["AXGroup", "AXScrollArea"] {
        var group = node(role)
        group.subrole = "AXUnknown"
        group.actions = ["AXShowMenu", "AXScrollToVisible"]
        #expect(group.transparent)
        group.description = "Last expression"
        #expect(!group.transparent)
        group.description = nil
        group.actions.append("AXCopy")
        #expect(!group.transparent)
        group.actions = []
        group.expanded = false
        #expect(!group.transparent)
    }
}

@Test func deduplicatesEqualFieldsAndDefersIdentifiersGeometryAndRawActions() {
    var button = node()
    button.title = "Mode"
    button.description = "Mode"
    button.help = "Choose calculator mode"
    button.identifier = "mode-control"
    button.bounds = WindowBounds(x: 10, y: 20, width: 30, height: 40)
    button.actions = ["AXPress", "AXShowMenu", "Name:Move previous\nTarget:0x123\nSelector:(null)"]
    #expect(AXTextFormatter.line(button, level: 0) == "- [7] AXButton \"Mode\" help=\"Choose calculator mode\" actions=[\"Move previous\"]")
    let detail = AXTextFormatter.line(button, level: 0, details: true)
    #expect(detail.contains("id=\"mode-control\""))
    #expect(detail.contains("bounds=[10.0,20.0,30.0,40.0]"))
    #expect(detail.contains("\\nTarget:0x123"))
    #expect(!detail.contains("description="))
}

@Test func retainsLinkTargetsAndUnknownGeometryWithoutInferringSelection() {
    var link = node("AXLink")
    link.title = "Example"
    link.url = "https://example.com/"
    link.selected = false
    #expect(AXTextFormatter.line(link, level: 0) == "- [7] AXLink \"Example\" url=\"https://example.com/\"")
    #expect(AXTextFormatter.line(link, level: 0, details: true).contains("selected=false"))
    #expect(AXTextFormatter.line(link, level: 0, details: true).contains("bounds=unavailable"))
}

@Test func keepsUTF16SelectionsAndRejectsOutOfTextRanges() {
    var text = node("AXTextArea")
    text.value = "a😀 target"
    text.valueWritable = true
    text.selectionWritable = true
    text.selectedRange = CFRange(location: 4, length: 6)
    text.selectedText = "target"
    text.validateSelection()
    #expect(AXTextFormatter.line(text, level: 1).hasSuffix("selection=[4,6] selectedText=\"target\""))
    for range in [CFRange(location: 54, length: 4294967290), CFRange(location: 4, length: Int.max)] {
        text.selectedRange = range
        text.validateSelection()
        #expect(text.invalidSelection)
        #expect(text.selectedRange == nil)
        #expect(text.selectedText == nil)
        #expect(AXTextFormatter.line(text, level: 0).hasSuffix("selection=unavailable"))
    }
}

@Test func actionAliasesResolveOnlyWhenUnambiguous() throws {
    let first = "Name:Move previous\nTarget:0x123\nSelector:(null)"
    let other = "Name:Move previous\nTarget:0x456\nSelector:(null)"
    #expect(try AXWorker.resolveAction("Move previous", names: [first]) == first)
    #expect(try AXWorker.resolveAction("press", names: ["AXPress"]) == "AXPress")
    #expect(throws: NativeFailure.self) { try AXWorker.resolveAction("Move previous", names: [first, other]) }
    #expect(try AXWorker.resolveAction(other, names: [first, other]) == other)
    #expect(throws: NativeFailure.self) { try AXWorker.resolveAction("missing", names: [first]) }
}

@Test func identifiesTheReachedTraversalLimit() {
    #expect(AXTextFormatter.truncation(maxElements: nil, maxDepth: 25).contains("(maxDepth=25)"))
    #expect(AXTextFormatter.truncation(maxElements: 2000, maxDepth: nil).contains("(maxElements=2000)"))
    #expect(AXTextFormatter.truncation(maxElements: 1, maxDepth: 1).contains("(maxElements=1, maxDepth=1)"))
}

@Test func repeatedWordsDoNotConflateLabelsValuesAndPlaceholders() {
    var field = node("AXTextField")
    field.title = "Example"
    field.description = "Example"
    field.value = "Example"
    field.placeholder = "Example"
    let line = AXTextFormatter.line(field, level: 0)
    #expect(line.contains("\"Example\" = \"Example\" placeholder=\"Example\""))
    #expect(!line.contains("description="))
    var button = node()
    button.description = "Delete"
    #expect(AXTextFormatter.line(button, level: 0) == "- [7] AXButton \"Delete\"")
    var wrapper = node("AXGroup")
    wrapper.subrole = "AXHostingView"
    #expect(wrapper.transparent)
}
