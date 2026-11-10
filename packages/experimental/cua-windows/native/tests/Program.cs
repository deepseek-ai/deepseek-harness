// Portable checks exercise admission, framing, text offsets, and model-visible formatting.
using System.Text;
using DeepSeek.Cua.Protocol;

var checks = 0;
void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
    checks++;
}
void Refuses(Action action, string code)
{
    try { action(); throw new Exception("Expected refusal: " + code); }
    catch (NativeFailure failure) { Check(failure.Code == code, "Unexpected refusal: " + failure.Code); }
}

var request = NativeRequest.Parse(WireJson.Parse("""{"id":"one","method":"getState","params":{"appHandle":"app","maxElements":20,"maxDepth":5}}"""));
Check(request.Method == "getState" && request.Id == "one", "Valid requests retain correlation and method");
foreach (var (maxElements, maxDepth) in new[] { (1, 1), (7, 3), (10000, 100), (10001, 101), (100000, 512) })
{
    var observation = NativeRequest.Parse(WireJson.Parse(System.Text.Json.JsonSerializer.Serialize(new
    {
        id = "limits", method = "getState", @params = new { appHandle = "app", windowId = "1", maxElements, maxDepth },
    })));
    Check(observation.Params.GetProperty("maxElements").GetInt32() == maxElements
        && observation.Params.GetProperty("maxDepth").GetInt32() == maxDepth,
        "Native accessibility requests retain per-read traversal limits");
}
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"one","method":"click","params":{"appHandle":"app","windowId":"1","x":-1,"y":2}}""")), "INVALID_ARGUMENT");
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"one","method":"getState","params":{"appHandle":"app","maxElements":0,"maxDepth":5}}""")), "INVALID_ARGUMENT");
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"one","method":"getState","params":{"appHandle":"app","maxElements":100001,"maxDepth":512}}""")), "INVALID_ARGUMENT");
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"one","method":"getState","params":{"appHandle":"app","maxElements":100000,"maxDepth":513}}""")), "INVALID_ARGUMENT");
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"one","method":"typeText","params":{"appHandle":"app","text":"hello","unowned":1}}""")), "INVALID_ARGUMENT");
Refuses(() => WireJson.Parse("""{"id":"one","id":"two"}"""), "INVALID_REQUEST");
Refuses(() => WireJson.Parse("""{"params":{"x":1,"x":2}}"""), "INVALID_REQUEST");
foreach (var path in new[] { @"C:\Tools\Editor.exe", @"D:\Portable Apps\编辑器.exe", @"\\server\tools\Editor.exe" })
{
    var selection = NativeRequest.Parse(WireJson.Parse(System.Text.Json.JsonSerializer.Serialize(new
    {
        id = "select", method = "getApp", @params = new { selector = path },
    })));
    Check(selection.Params.GetProperty("selector").GetString() == path, "Executable selection preserves the exact path on the wire");
}
foreach (var method in new[] { "listActions", "performAction", "invoke", "mouseMove", "click", "setValue", "selectText" })
{
    var parameters = new Dictionary<string, string>
    {
        ["appHandle"] = "app", ["windowId"] = "1", ["snapshotId"] = "snapshot", ["elementId"] = "42/-7/9",
    };
    if (method == "performAction") parameters["action"] = "Invoke.Invoke";
    if (method == "setValue") parameters["value"] = "text";
    if (method == "selectText") parameters["text"] = "text";
    var operation = NativeRequest.Parse(WireJson.Parse(System.Text.Json.JsonSerializer.Serialize(new
    {
        id = "element", method, @params = parameters,
    })));
    Check(operation.Params.GetProperty("elementId").GetString() == "42/-7/9", "Element operations preserve slash-separated RuntimeIds: " + method);
}
var launch = NativeRequest.Parse(WireJson.Parse("""{"id":"launch","method":"launchApp","params":{"appHandle":"pending"}}"""));
Check(launch.Method == "launchApp" && launch.Params.GetProperty("appHandle").GetString() == "pending",
    "Host launch continuation retains the selected application handle");
foreach (var parameters in new[] { "{}", "{\"appHandle\":\"\"}", "{\"selector\":\"Example.App\"}",
    "{\"appHandle\":\"pending\",\"appId\":\"Other.App\"}", "{\"appHandle\":\"pending\",\"arguments\":\"--other\"}" })
    Refuses(() => NativeRequest.Parse(WireJson.Parse("{\"id\":\"launch\",\"method\":\"launchApp\",\"params\":" + parameters + "}")), "INVALID_ARGUMENT");

Check(NativeControlFrame.Parse(WireJson.Parse("""{"type":"close"}"""), null) == NativeControl.Close, "Connection close needs no active operation");
Check(NativeControlFrame.Parse(WireJson.Parse("""{"type":"cancel","id":"one"}"""), "one") == NativeControl.Cancel, "Cancellation matches the live operation");
Check(NativeControlFrame.Parse(WireJson.Parse("""{"type":"cancel","id":"one"}"""), "one", completed: true) == NativeControl.CompletedCancel,
    "Cancellation arriving after the matching response is a no-op");
foreach (var frame in new[] { "null", "[]", "{}", "{\"type\":1}",
    "{\"type\":\"close\",\"extra\":1}", "{\"type\":\"cancel\"}",
    "{\"type\":\"cancel\",\"id\":null}", "{\"type\":\"cancel\",\"id\":1}",
    "{\"type\":\"cancel\",\"id\":\"other\"}", "{\"type\":\"cancel\",\"id\":\"one\",\"extra\":1}" })
    Refuses(() => NativeControlFrame.Parse(WireJson.Parse(frame), "one"), "INVALID_REQUEST");
Refuses(() => NativeControlFrame.Parse(WireJson.Parse("""{"type":"cancel","id":null}"""), null), "INVALID_REQUEST");
Refuses(() => NativeControlFrame.Parse(WireJson.Parse("""{"type":"cancel","id":"one"}"""), null), "INVALID_REQUEST");

var bytes = Encoding.UTF8.GetBytes("你好\nnext\n");
var reader = new FrameReader(new MemoryStream(bytes));
Check(await reader.ReadAsync(7, CancellationToken.None) == "你好", "Frame limits count UTF-8 bytes including newline");
Check(await reader.ReadAsync(5, CancellationToken.None) == "next", "Buffered next frames remain readable");
Check(await reader.ReadAsync(1, CancellationToken.None) is null, "Clean EOF is distinct from a partial frame");
try { await new FrameReader(new MemoryStream(bytes)).ReadAsync(6, CancellationToken.None); throw new Exception("Oversized frame accepted"); }
catch (NativeFailure failure) { Check(failure.Code == "NATIVE_REQUEST_LIMIT", "Oversized UTF-8 frames fail before parsing"); }
try { await new FrameReader(new MemoryStream("partial"u8.ToArray())).ReadAsync(20, CancellationToken.None); throw new Exception("Partial frame accepted"); }
catch (NativeFailure failure) { Check(failure.Code == "INVALID_REQUEST", "Partial EOF is rejected"); }
try { await new FrameReader(new MemoryStream([0xff, 0x0a])).ReadAsync(2, CancellationToken.None); throw new Exception("Invalid UTF-8 accepted"); }
catch (DecoderFallbackException) { checks++; }

Check(TextSelection.Find("😀 first repeat; second repeat", "repeat", "second ", null) == new TextMatch(24, 6), "Offsets use UTF-16 including surrogate pairs");
Refuses(() => TextSelection.Find("repeat repeat", "repeat", null, null), "AMBIGUOUS_TEXT");
Refuses(() => TextSelection.Find("repeat", "other", null, null), "TEXT_NOT_FOUND");
Refuses(() => TextSelection.Find("text", "", null, null), "INVALID_ARGUMENT");
Check(TextSelection.Find("aaaa", "aa", "aa", null) == new TextMatch(2, 2), "Overlapping literal matches retain adjacent context");

var html = HtmlClipboard.Encode("<b>你好😀</b>");
var header = Encoding.UTF8.GetString(html);
int Offset(string name) => int.Parse(header.Split('\n').Single(line => line.StartsWith(name + ':')).Split(':')[1].Trim());
Check(Encoding.UTF8.GetString(html, Offset("StartFragment"), Offset("EndFragment") - Offset("StartFragment")) == "<b>你好😀</b>", "CF_HTML byte offsets preserve Unicode");
Check(Offset("EndHTML") == html.Length - 1, "CF_HTML excludes the terminating NUL");

Check(KeyChord.Parse("ctrl++", []).Key == "+", "Plus key remains a key after chord parsing");
Check(KeyChord.Parse("+", []).Modifiers.Length == 0, "Bare plus has no modifier");
Check(KeyChord.Parse("Control+a", ["ctrl"]).Modifiers.SequenceEqual(["control"]), "Equivalent modifiers deduplicate");
Refuses(() => KeyChord.Parse("ctrl+", []), "INVALID_ARGUMENT");
Refuses(() => KeyChord.Parse("fn+a", []), "UNSUPPORTED");

var button = new AccessibilityNode { ControlType = "Button", Name = "保存", HelpText = "保存当前文档", AutomationId = "saveButton" };
foreach (var details in new[] { false, true })
{
    Check(AccessibilityText.Format(button, "1/2/3", details) == "- [1/2/3] Button \"保存\" helpText=\"保存当前文档\" automationId=\"saveButton\"",
        "Name, HelpText and AutomationId are available in both detail modes");
    Check(AccessibilityText.Format(button with { Enabled = false }, "1/2/3", details) == "- [1/2/3] Button disabled \"保存\" helpText=\"保存当前文档\" automationId=\"saveButton\"",
        "Disabled controls retain RuntimeId and metadata");
    Check(AccessibilityText.Format(new() { ControlType = "Text", Name = "说明" }, "42/-7/9", details) == "- [42/-7/9] Text \"说明\"",
        "Controls without patterns also expose their RuntimeId");
    Check(AccessibilityText.Format(button with { HelpText = "保存" }, "1/2/3", details).Contains("helpText=\"保存\""),
        "Nonempty HelpText is retained even when it equals Name");
    Check(AccessibilityText.Format(button with { HelpText = "", AutomationId = "" }, "1/2/3", details) == "- [1/2/3] Button \"保存\"",
        "Empty optional metadata is omitted");
    Check(AccessibilityText.Format(button with { HelpText = null, AutomationId = null }, "1/2/3", details) == "- [1/2/3] Button \"保存\"",
        "Missing optional metadata is omitted");
}
Check(AccessibilityText.Retain(new() { ControlType = "Group", AutomationId = "toolbar" }), "AutomationId keeps otherwise empty containers visible");
var node = new AccessibilityNode { ControlType = "Edit", Name = "Title", Value = "", HasValue = true, Placeholder = "Title", ValueWritable = "true", Patterns = ["Invoke", "Value", "Text"] };
var text = AccessibilityText.Format(node, "1/2/3", false);
Check(text == "- [1/2/3] Edit valueWritable=true \"Title\" = \"\" placeholder=\"Title\" patterns=[\"Invoke\", \"Value\", \"Text\"]",
    "Rows expose native control and pattern names without action names");
foreach (var controlType in new[] { "Group", "Other", "ListItem", "TreeItem", "TabItem", "Table", "DataGrid" })
    Check(AccessibilityText.Format(new() { ControlType = controlType }, "1/2/3", false) == "- [1/2/3] " + controlType,
        "Formatting preserves distinct Windows control types: " + controlType);
Check(!AccessibilityText.Retain(new() { ControlType = "Other" }), "Empty fallback containers can collapse");
Check(AccessibilityText.Retain(new() { ControlType = "Other", Name = "Custom content" }), "Named fallback containers retain their row");
Check(text.Contains("= \"\" placeholder=\"Title\""), "Empty values and placeholders remain distinct");
Check(AccessibilityText.Format(node, "1/2/3", true) == text, "Both detail modes expose patterns without expanding actions");
var selectionPatterns = new AccessibilityNode { ControlType = "ListItem", Patterns = ["SelectionItem", "ExpandCollapse", "ScrollItem"] };
foreach (var details in new[] { false, true })
{
    var row = AccessibilityText.Format(selectionPatterns, "42/-7/9", details);
    Check(row == "- [42/-7/9] ListItem patterns=[\"SelectionItem\", \"ExpandCollapse\", \"ScrollItem\"]",
        "One control exposes all of its patterns, once per pattern rather than once per action");
    Check(!row.Contains("actions=") && !row.Contains("SelectionItem.Select") && !row.Contains("ExpandCollapse.Collapse"),
        "Neither detail mode includes action lists");
}
Check(!AccessibilityText.Retain(new() { ControlType = "Group" }), "Empty structural containers can collapse");
Check(AccessibilityText.Retain(new() { ControlType = "Group", Patterns = ["Value"] }), "Actionable containers retain their row");
var queryOnly = new AccessibilityNode { ControlType = "Group", Patterns = ["Selection", "Grid", "Table"] };
Check(AccessibilityText.Retain(queryOnly), "Query-only patterns keep otherwise empty containers visible");
Check(AccessibilityText.Format(queryOnly, "1/2/3", false) == "- [1/2/3] Group patterns=[\"Selection\", \"Grid\", \"Table\"]",
    "Query-only patterns are visible without claiming executable actions");
Check(AccessibilityText.Format(new() { ControlType = "Document", Value = "abc", HasValue = true, HasSelection = true, Selection = new(2, 5) }, "1/2/3", false)
    .Contains("selection=unavailable"), "Out-of-range selections do not describe valid text");
Console.WriteLine($"{checks} portable CUA checks passed");
