// Portable checks exercise admission, pattern action schemas, framing, text offsets, and model-visible formatting.
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DeepSeek.Cua.Protocol;
using DeepSeek.Cua.Windows;
using Json.Schema;

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

var editorId = "Fixture.Editor!App";
var originalPath = Path.GetFullPath("Editor.exe");
var movedPath = Path.GetFullPath(Path.Combine("moved", "Editor.exe"));
var original = ApplicationAuthorization.Create(editorId, "Editor", originalPath);
var updated = ApplicationAuthorization.Create(editorId, "Updated Editor", movedPath);
Check(original.Persistable, "Application consent can be saved");
Check(original.Id == updated.Id, "Versions and copies declaring the same AUMID share consent");
Check(original.Id != ApplicationAuthorization.Create("Fixture.Editor!Other", "Other", originalPath).Id,
    "Distinct application identifiers do not share consent even at the same executable path");
Check(original.Id == Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(
    System.Text.Encoding.UTF8.GetBytes("windows-aumid\0" + editorId))), "Existing AUMID authorization keys remain stable");
Check(ApplicationAuthorization.Create(originalPath, "Editor", originalPath).Id
    != ApplicationAuthorization.Create(movedPath, "Editor", movedPath).Id,
    "Unidentified applications use separate canonical paths");
var observed = ApplicationAuthorization.Create(originalPath, "Editor", originalPath,
    [editorId, null, "", editorId, "Shell.Editor"], [originalPath, originalPath.ToUpperInvariant(), movedPath]);
Check(observed.Attributes["windows.aumid"].SequenceEqual(new[] { editorId, "Shell.Editor" }),
    "Window, package and Shell AUMIDs contribute nonempty distinct permission attributes");
Check(observed.Attributes["windows.executablePath"].Length == 2, "Permission paths ignore case and retain distinct locations");
Check(observed.Id == ApplicationAuthorization.Create(originalPath, "Editor", originalPath).Id,
    "Additional permission attributes do not replace the native application identifier");

var handshakeConfig = new JsonObject
{
    ["maxRequestBytes"] = 8192, ["maxResponseBytes"] = 8192, ["axTimeoutMs"] = 10, ["textEventIntervalMs"] = 0,
    ["screenshotTimeoutMs"] = 10, ["timeoutMs"] = 50, ["graceMs"] = 10, ["pollIntervalMs"] = 1,
    ["launchWaitMs"] = 10, ["maxClickHoldMs"] = 25,
};
NativeConfig ReadConfig() => NativeConfig.Parse(JsonSerializer.SerializeToElement(handshakeConfig));
Check(ReadConfig().MaxDiffNotifications == 50, "An existing handshake defaults to 50 distinct notifications");
handshakeConfig["maxDiffNotifications"] = 2;
Check(ReadConfig().MaxDiffNotifications == 2, "The handshake overrides the diff limit independently of tree traversal");
foreach (var invalid in new[] { "0", "-1", "1.5", "2147483648", "null", "\"2\"" })
{
    handshakeConfig["maxDiffNotifications"] = JsonNode.Parse(invalid);
    Refuses(() => ReadConfig(), "INVALID_CONFIG");
}

NotificationChecks.Run(Check);
await NotificationCleanupChecks.Run(Check);
AccessibilityTraversalChecks.Run(Check);

var request = NativeRequest.Parse(WireJson.Parse("""{"id":"one","method":"getState","params":{"appHandle":"app","maxElements":20,"maxDepth":5}}"""));
Check(request.Method == "getState" && request.Id == "one", "Valid requests retain correlation and method");
var fullTreeRequest = NativeRequest.Parse(WireJson.Parse("""{"id":"full","method":"getState","params":{"appHandle":"app","maxElements":20,"maxDepth":5,"showDiff":false}}"""));
Check(!fullTreeRequest.Params.GetProperty("showDiff").GetBoolean(), "Explicit full-tree reads remain supported");
var diffRequest = NativeRequest.Parse(WireJson.Parse("""{"id":"diff","method":"getState","params":{"appHandle":"app","maxElements":20,"maxDepth":5,"showDiff":true}}"""));
Check(diffRequest.Id == "diff" && diffRequest.Params.GetProperty("showDiff").GetBoolean(), "Difference requests reach the executor with their correlation ID");
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"diff","method":"getState","params":{"appHandle":"app","maxElements":20,"maxDepth":5,"showDiff":"true"}}""")), "INVALID_ARGUMENT");
foreach (var (maxElements, maxDepth) in new[] { (1, 1), (7, 3), (10000, 100) })
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
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"one","method":"getState","params":{"appHandle":"app","maxElements":10001,"maxDepth":100}}""")), "INVALID_ARGUMENT");
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"one","method":"getState","params":{"appHandle":"app","maxElements":10000,"maxDepth":101}}""")), "INVALID_ARGUMENT");
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"one","method":"typeText","params":{"appHandle":"app","text":"hello","unowned":1}}""")), "INVALID_ARGUMENT");
foreach (var query in new string?[] { "", null, " \t\n", "Editor" })
{
    var search = NativeRequest.Parse(WireJson.Parse(System.Text.Json.JsonSerializer.Serialize(new
    {
        id = "all-apps", method = "findApps", @params = new { query, maxAppMatches = 1 },
    })));
    Check(search.Params.GetProperty("query").GetString() == query, "Application query admission preserves strings and null");
}
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"search","method":"findApps","params":{"maxAppMatches":1}}""")), "INVALID_ARGUMENT");
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
foreach (var mouseButton in new[] { "left", "right", "middle" })
foreach (var direction in new[] { "down", "up" })
{
    var toggle = NativeRequest.Parse(WireJson.Parse(System.Text.Json.JsonSerializer.Serialize(new
    {
        id = "mouse", method = "toggleMouse", @params = new { appHandle = "app", windowId = "1", mouseButton, direction },
    })));
    Check(toggle.Params.GetProperty("mouseButton").GetString() == mouseButton
        && toggle.Params.GetProperty("direction").GetString() == direction,
        "Mouse-button events retain the explicit button and direction");
}
foreach (var invalid in new[]
{
    """{"appHandle":"app","windowId":"1","mouseButton":"left","direction":"down","taskId":"other"}""",
    """{"appHandle":"app","windowId":"1","mouseButton":"left"}""",
    """{"appHandle":"app","windowId":"1","direction":"down"}""",
    """{"appHandle":"app","mouseButton":"left","direction":"down"}""",
    """{"appHandle":"app","windowId":"1","mouseButton":"back","direction":"down"}""",
    """{"appHandle":"app","windowId":"1","mouseButton":"left","direction":"press"}""",
    """{"appHandle":"app","windowId":"1","mouseButton":"left","direction":"down","x":1,"y":2}""",
})
    Refuses(() => NativeRequest.Parse(WireJson.Parse("{\"id\":\"mouse\",\"method\":\"toggleMouse\",\"params\":" + invalid + "}")), "INVALID_ARGUMENT");

foreach (var method in new[] { "getHeldInputs", "releaseHeldInputs" })
{
    var query = $$$"""{"id":"holds","method":"{{{method}}}","params":{}}""";
    Check(NativeRequest.Parse(WireJson.Parse(query)).Method == method, "Held-input operations use the requesting connection");
    Refuses(() => NativeRequest.Parse(WireJson.Parse($$$"""{"id":"holds","method":"{{{method}}}","params":{"taskId":"other"}}""")), "INVALID_ARGUMENT");
}
HeldInputChecks.Run(Check, Refuses);

var actionSchema = NativeRequest.Parse(WireJson.Parse("""{"id":"schema","method":"getActionSchema","params":{"action":"Invoke.Invoke"}}"""));
Check(actionSchema.Params.EnumerateObject().Select(item => item.Name).SequenceEqual(["action"]),
    "Action schema requests carry only the exact action name");
foreach (var parameters in new[] { """{}""", """{"action":""}""", """{"action":"Invoke.Invoke","appHandle":"app"}""",
    """{"action":"Invoke.Invoke","windowId":"1"}""", """{"action":"Invoke.Invoke","elementId":"1"}""" })
    Refuses(() => NativeRequest.Parse(WireJson.Parse("{\"id\":\"schema\",\"method\":\"getActionSchema\",\"params\":" + parameters + "}")), "INVALID_ARGUMENT");

var newInstance = NativeRequest.Parse(WireJson.Parse("""{"id":"new-instance","method":"launchApp","params":{"appHandle":"selected"}}"""));
Check(newInstance.Method == "launchApp" && newInstance.Params.GetProperty("appHandle").GetString() == "selected",
    "New-instance launch retains the selected application handle");
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"new-instance","method":"launchApp","params":{"appHandle":"selected","windowId":"1"}}""")), "INVALID_ARGUMENT");
var launch = NativeRequest.Parse(WireJson.Parse("""{"id":"launch","method":"launchApp","params":{"appHandle":"pending"}}"""));
Check(launch.Method == "launchApp" && launch.Params.GetProperty("appHandle").GetString() == "pending",
    "Host launch continuation retains the selected application handle");
foreach (var parameters in new[] { "{}", "{\"appHandle\":\"\"}", "{\"selector\":\"Example.App\"}",
    "{\"appHandle\":\"pending\",\"appId\":\"Other.App\"}", "{\"appHandle\":\"pending\",\"arguments\":\"--other\"}" })
    Refuses(() => NativeRequest.Parse(WireJson.Parse("{\"id\":\"launch\",\"method\":\"launchApp\",\"params\":" + parameters + "}")), "INVALID_ARGUMENT");

Check(NativeControlFrame.Parse(WireJson.Parse("""{"type":"close"}"""), null) == NativeControl.Close, "Connection close needs no active operation");
Check(NativeControlFrame.Parse(WireJson.Parse("""{"type":"cancel","id":"one"}"""), "one") == NativeControl.Cancel, "Cancellation matches the live operation");
Check(NativeControlFrame.Parse(WireJson.Parse("""{"type":"cancel","id":"one"}"""), "one", completed: true) == NativeControl.CompletedCancel,
    "Cancellation can identify a discarded reply after the matching operation completes");
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

Check(KeyChord.ModifiersForPress("+", []).Length == 0, "Bare plus has no modifier");
Check(KeyChord.ModifiersForPress("a", ["SHIFT", "Control", "ctrl", "ALT"]).SequenceEqual(["shift", "ctrl", "alt"]),
    "Application shortcuts normalize aliases and preserve modifier order");
Check(KeyChord.NormalizeModifier("win") == "win", "Pointer gestures accept the Win modifier");
foreach (var key in new[] { "r", "l", "d", "a" })
    Refuses(() => KeyChord.ModifiersForPress(key, ["shift", "WIN"]), "UNSUPPORTED");
Refuses(() => KeyChord.ModifiersForPress("Tab", ["alt"]), "UNSUPPORTED");
Refuses(() => KeyChord.ModifiersForPress("Esc", ["control"]), "UNSUPPORTED");
Refuses(() => KeyChord.ModifiersForPress("Delete", ["ctrl", "alt"]), "UNSUPPORTED");
Refuses(() => KeyChord.ModifiersForPress("PrintScreen", []), "UNSUPPORTED");
Refuses(() => KeyChord.ModifiersForPress("a", ["fn"]), "UNSUPPORTED");
foreach (var modifier in new[] { "option", "command", "unknown" })
    Refuses(() => KeyChord.ModifiersForPress("a", [modifier]), "INVALID_ARGUMENT");

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

// The pattern registry owns both the JSON Schema and the binder; schemas only type values, binders enforce them.
var actionArguments = new Dictionary<string, string?>(StringComparer.Ordinal)
{
    ["Invoke.Invoke"] = null,
    ["Toggle.Toggle"] = null,
    ["SelectionItem.Select"] = null,
    ["SelectionItem.AddToSelection"] = null,
    ["SelectionItem.RemoveFromSelection"] = null,
    ["ExpandCollapse.Expand"] = null,
    ["ExpandCollapse.Collapse"] = null,
    ["ScrollItem.ScrollIntoView"] = null,
    ["Value.SetValue"] = "\"text\"",
    ["RangeValue.SetValue"] = "42.5",
    ["Scroll.Scroll"] = """{"horizontalAmount":"NoAmount","verticalAmount":"LargeIncrement"}""",
    ["Scroll.ScrollHorizontal"] = "\"SmallDecrement\"",
    ["Scroll.ScrollVertical"] = "\"LargeIncrement\"",
    ["Scroll.SetScrollPercent"] = """{"horizontalPercent":50,"verticalPercent":-1}""",
    ["Transform.Move"] = """{"x":10,"y":20.5}""",
    ["Transform.Resize"] = """{"width":800,"height":600}""",
    ["Transform.Rotate"] = "15",
    ["Window.Close"] = null,
    ["Window.SetWindowVisualState"] = "\"Maximized\"",
    ["Dock.SetDockPosition"] = "\"Left\"",
    ["MultipleView.SetCurrentView"] = "2",
    ["VirtualizedItem.Realize"] = null,
    ["SynchronizedInput.StartListening"] = "\"KeyDown\"",
    ["SynchronizedInput.Cancel"] = null,
};
Check(actionArguments.Keys.Order().SequenceEqual(PatternActions.Names(_ => true).Order()),
    "Action schema checks cover every registered action");
Refuses(() => PatternActions.Schema("Missing.Action"), "UNSUPPORTED");

string[] scrollAmounts = ["LargeDecrement", "SmallDecrement", "NoAmount", "LargeIncrement", "SmallIncrement"];
var enumValues = new Dictionary<string, string[]>(StringComparer.Ordinal)
{
    ["Scroll.ScrollHorizontal"] = scrollAmounts,
    ["Scroll.ScrollVertical"] = scrollAmounts,
    ["Scroll.Scroll/horizontalAmount"] = scrollAmounts,
    ["Scroll.Scroll/verticalAmount"] = scrollAmounts,
    ["Window.SetWindowVisualState"] = ["Normal", "Maximized", "Minimized"],
    ["Dock.SetDockPosition"] = ["Top", "Left", "Bottom", "Right", "Fill", "None"],
    ["SynchronizedInput.StartListening"] = ["KeyUp", "KeyDown", "MouseLeftButtonUp", "MouseLeftButtonDown", "MouseRightButtonUp", "MouseRightButtonDown"],
};
var positiveMembers = new HashSet<string>(StringComparer.Ordinal) { "Transform.Resize/width", "Transform.Resize/height" };
var percentMembers = new HashSet<string>(StringComparer.Ordinal) { "Scroll.SetScrollPercent/horizontalPercent", "Scroll.SetScrollPercent/verticalPercent" };

// Registered schemas are reusable JsonSchema instances; structure checks work on serialized copies.
JsonSchema Schema(string action) => PatternActions.Schema(action);
PatternAction RegisteredAction(string action) => PatternActions.Patterns
    .SelectMany(pattern => pattern.Actions).Single(candidate => candidate.Name == action);
JsonObject Serialized(string action) => JsonSerializer.SerializeToNode(Schema(action), WireJson.Options)!.AsObject();
bool SchemaAccepts(string action, string parameters) =>
    Schema(action).Evaluate(WireJson.Parse(parameters), new EvaluationOptions { OutputFormat = OutputFormat.Flag }).IsValid;
string Parameter(string argument) => "{\"argument\":" + argument + "}";
void Accepts(string action, string argument)
{
    Check(SchemaAccepts(action, Parameter(argument)), $"The schema accepts {argument} for {action}");
    Check(PatternActions.Resolve(action, WireJson.Parse(argument)).Invoke is not null, $"The action binds {argument} for {action}");
}
void Rejects(string action, string argument)
{
    Check(!SchemaAccepts(action, Parameter(argument)), $"The schema rejects {argument} for {action}");
    Refuses(() => PatternActions.Resolve(action, WireJson.Parse(argument)), "INVALID_ARGUMENT");
}
void Tolerates(string action, string argument)
{
    Check(SchemaAccepts(action, Parameter(argument)), $"The broad schema accepts {argument} for {action}");
    Refuses(() => PatternActions.Resolve(action, WireJson.Parse(argument)), "INVALID_ARGUMENT");
}
string Member(JsonObject fields, string name, string value)
{
    var changed = fields.DeepClone().AsObject();
    changed[name] = JsonNode.Parse(value);
    return changed.ToJsonString();
}

foreach (var (action, argument) in actionArguments)
{
    var schema = Serialized(action);
    var properties = schema["properties"]?.AsObject();
    var required = schema["required"]?.AsArray();
    Check(schema["type"]?.GetValue<string>() == "object", "Action parameters are one object: " + action);
    Check(schema["description"] is null, "Descriptions stay off the CUA envelope: " + action);
    Check(schema["additionalProperties"]?.GetValue<bool>() == false, "Action parameters reject extra keys: " + action);
    Check(properties is { Count: 1 } && properties.ContainsKey("argument"), "Action parameters contain only the argument: " + action);
    Check(required is not null && required.Count == (argument is null ? 0 : 1), "Argument requirement matches the action grammar: " + action);
    if (argument is null)
    {
        Check(SchemaAccepts(action, "{}"), "A parameter-free action accepts an omitted argument: " + action);
        Accepts(action, "null");
        Rejects(action, "\"text\"");
        Rejects(action, "0");
        continue;
    }
    Accepts(action, argument);
    Check(!SchemaAccepts(action, "{}"), "A required argument cannot be omitted: " + action);
    Refuses(() => PatternActions.Resolve(action, null), "INVALID_ARGUMENT");
    Check(!SchemaAccepts(action, "{\"argument\":" + argument + ",\"extra\":1}"), "Extra parameters are rejected: " + action);
    var argumentSchema = properties!["argument"]!.AsObject();
    switch (argumentSchema["type"]?.GetValue<string>())
    {
        case "string" when enumValues.TryGetValue(action, out var names):
            foreach (var name in names) Accepts(action, JsonValue.Create(name)!.ToJsonString());
            Tolerates(action, "\"NotAnAction\"");
            Rejects(action, "1");
            break;
        case "string":
            Rejects(action, "1");
            Rejects(action, "null");
            Rejects(action, "{}");
            break;
        case "number" when action == "MultipleView.SetCurrentView":
            Accepts(action, "0");
            Accepts(action, "-2147483648");
            Accepts(action, "2147483647");
            Tolerates(action, "1.5");
            Tolerates(action, "2147483648");
            Tolerates(action, "1.0");
            Rejects(action, "\"2\"");
            break;
        case "number":
            Accepts(action, "0");
            Rejects(action, "\"1\"");
            Rejects(action, "{}");
            break;
        case "object":
        {
            var fields = JsonNode.Parse(argument)!.AsObject();
            var members = argumentSchema["properties"]!.AsObject();
            var memberRequired = argumentSchema["required"]!.AsArray().Select(name => name!.GetValue<string>()).ToArray();
            Check(argumentSchema["additionalProperties"]!.GetValue<bool>() == false, "Pair arguments reject extra keys: " + action);
            Check(memberRequired.Order().SequenceEqual(members.Select(member => member.Key).Order()),
                "Pair arguments require exactly their native parameter names: " + action);
            foreach (var member in members)
            {
                var memberSchema = member.Value!.AsObject();
                var memberKey = action + "/" + member.Key;
                var missing = fields.DeepClone().AsObject();
                missing.Remove(member.Key);
                Rejects(action, missing.ToJsonString());
                Rejects(action, Member(fields, "extra", "1"));
                switch (memberSchema["type"]?.GetValue<string>())
                {
                    case "string" when enumValues.TryGetValue(memberKey, out var memberNames):
                        foreach (var name in memberNames)
                            Accepts(action, Member(fields, member.Key, JsonValue.Create(name)!.ToJsonString()));
                        Tolerates(action, Member(fields, member.Key, "\"NotAnAction\""));
                        Rejects(action, Member(fields, member.Key, "1"));
                        break;
                    case "string":
                        Rejects(action, Member(fields, member.Key, "1"));
                        break;
                    case "number" when positiveMembers.Contains(memberKey):
                        Accepts(action, Member(fields, member.Key, "0.5"));
                        Tolerates(action, Member(fields, member.Key, "0"));
                        Tolerates(action, Member(fields, member.Key, "-1"));
                        Rejects(action, Member(fields, member.Key, "\"text\""));
                        break;
                    case "number" when percentMembers.Contains(memberKey):
                        Accepts(action, Member(fields, member.Key, "100"));
                        Accepts(action, Member(fields, member.Key, "-1"));
                        Tolerates(action, Member(fields, member.Key, "101"));
                        Tolerates(action, Member(fields, member.Key, "-2"));
                        Rejects(action, Member(fields, member.Key, "\"text\""));
                        break;
                    case "number":
                        Accepts(action, Member(fields, member.Key, "0"));
                        Rejects(action, Member(fields, member.Key, "\"text\""));
                        break;
                    default:
                        throw new Exception("Unexpected pair member schema: " + memberKey);
                }
            }
            break;
        }
        default:
            throw new Exception("Unexpected action argument schema: " + action);
    }
}

// Descriptions carry the value facts the parsers enforce; enum descriptions reuse the parser's name list.
JsonObject SerializedArgument(string action) => Serialized(action)["properties"]!.AsObject()["argument"]!.AsObject();
string Description(string action, string? member = null) => (member is null ? SerializedArgument(action)
    : SerializedArgument(action)["properties"]!.AsObject()[member]!.AsObject())["description"]!.GetValue<string>();
Check(Description("Value.SetValue") == "Text to set as the element value.", "String arguments describe their accepted text");
Check(Description("RangeValue.SetValue").Contains("Minimum and Maximum") && Description("RangeValue.SetValue").Contains("finite"),
    "Range arguments describe the element's live range and finite numbers");
Check(Description("Transform.Rotate").Contains("clockwise") && Description("Transform.Rotate").Contains("counterclockwise")
    && Description("Transform.Rotate").Contains("finite"), "Rotation describes its sign convention and finite numbers");
foreach (var member in new[] { "width", "height" })
    Check(Description("Transform.Resize", member) == "Pixel dimension; must be positive.",
        "Resize describes the provider's positive pixel requirement: " + member);
foreach (var member in new[] { "x", "y" })
    Check(Description("Transform.Move", member).Contains("Screen coordinate") && Description("Transform.Move", member).Contains("finite"),
        "Move describes finite screen coordinates: " + member);
foreach (var member in new[] { "horizontalPercent", "verticalPercent" })
    Check(Description("Scroll.SetScrollPercent", member).Contains("0 to 100") && Description("Scroll.SetScrollPercent", member).Contains("-1")
        && Description("Scroll.SetScrollPercent", member).Contains("NoScroll"),
        "Scroll percentages describe the 0..100 range and NoScroll: " + member);
Check(Description("MultipleView.SetCurrentView") == "A 32-bit integer element view ID.",
    "View selection describes its 32-bit integer parse");
foreach (var (key, names) in enumValues)
{
    var slash = key.IndexOf('/');
    var action = slash < 0 ? key : key[..slash];
    var description = Description(action, slash < 0 ? null : key[(slash + 1)..]);
    foreach (var name in names) Check(description.Contains(name), "Enum descriptions reuse the parser's exact names: " + key + " -> " + name);
    Check(description.Contains("case-sensitive"), "Enum descriptions state case sensitivity: " + key);
}
Check(Description("Window.SetWindowVisualState") == "Accepted values: Normal, Maximized, Minimized (case-sensitive).",
    "Window state describes the exact visual states");

// Registered schemas are stable instances; mutating serialized copies cannot change them or their siblings.
var mutated = SerializedArgument("Scroll.ScrollHorizontal");
mutated["description"] = "mutated";
Check(Description("Scroll.ScrollHorizontal") != "mutated", "The registered schema keeps its description");
Check(ReferenceEquals(Schema("Scroll.ScrollHorizontal"), Schema("Scroll.ScrollHorizontal")),
    "Repeated queries return the registered schema instance");
Check(ReferenceEquals(Schema("Scroll.ScrollHorizontal"), RegisteredAction("Scroll.ScrollHorizontal").ParameterSchema),
    "Queries return the action's registered schema");
Check(Description("Scroll.ScrollVertical") != "mutated", "Actions sharing an enum parser keep their own descriptions");
var pairMutated = SerializedArgument("Transform.Resize");
pairMutated["properties"]!.AsObject()["width"]!.AsObject()["description"] = "mutated";
Check(Description("Transform.Resize", "width") != "mutated" && Description("Transform.Resize", "height") == "Pixel dimension; must be positive.",
    "Pair members keep their registered descriptions");

// NativeServer serializes { id, result } with WireJson.Options, so a registered schema must stay a plain object there.
var reply = JsonSerializer.SerializeToUtf8Bytes(new { id = "schema", result = (object)Schema("Transform.Resize") }, WireJson.Options);
var payload = JsonNode.Parse(reply)!.AsObject();
var envelope = payload["result"]!.AsObject();
Check(payload["id"]!.GetValue<string>() == "schema", "The response envelope keeps the request id");
Check(payload.Count == 2 && envelope["type"]!.GetValue<string>() == "object", "The response result is the schema object");
foreach (var metadata in new[] { "Root", "BaseUri", "$id", "$schema" })
    Check(!envelope.ContainsKey(metadata), "The response result carries no library metadata: " + metadata);
Check(envelope.ToJsonString() == Serialized("Transform.Resize").ToJsonString(), "The response result matches the registered schema");
var roundtrip = JsonSchema.FromText(envelope.ToJsonString());
var evaluation = new EvaluationOptions { OutputFormat = OutputFormat.Flag };
foreach (var (parameters, accepted) in new[] {
    ("""{"argument":{"width":800,"height":600}}""", true),
    ("""{"argument":{"width":"wide","height":600}}""", false),
})
{
    Check(roundtrip.Evaluate(WireJson.Parse(parameters), evaluation).IsValid == accepted,
        "The roundtripped schema validates like the registered schema: " + parameters);
    Check(Schema("Transform.Resize").Evaluate(WireJson.Parse(parameters), evaluation).IsValid == accepted,
        "The registered schema validates like the response envelope: " + parameters);
}
Check(JsonSerializer.Serialize(roundtrip, WireJson.Options) == JsonSerializer.Serialize(Schema("Transform.Resize"), WireJson.Options),
    "The roundtripped schema serializes to the registered JSON");

// Every registry schema stays deliberately broad: value types, named fields, and annotations, never value constraints.
var schemaKeywords = new HashSet<string>(StringComparer.Ordinal) { "type", "properties", "required", "additionalProperties", "description" };
void Broad(JsonObject schema, string position)
{
    foreach (var keyword in schema)
    {
        Check(schemaKeywords.Contains(keyword.Key), "Broad schemas avoid refined keywords: " + position + "." + keyword.Key);
        switch (keyword.Key)
        {
            case "type":
                Check(keyword.Value!.GetValue<string>() is "object" or "string" or "number" or "null",
                    "Broad schemas use plain value types: " + position);
                break;
            case "properties":
                foreach (var member in keyword.Value!.AsObject()) Broad(member.Value!.AsObject(), position + "." + member.Key);
                break;
            case "required":
                Check(keyword.Value!.AsArray().All(name => name is not null), "Broad schemas name required fields: " + position);
                break;
            case "additionalProperties":
                Check(keyword.Value!.GetValue<bool>() == false, "Broad object schemas reject unlisted fields: " + position);
                break;
            case "description":
                Check(keyword.Value is JsonValue text && text.GetValueKind() == JsonValueKind.String
                    && text.GetValue<string>().Length > 0, "Action descriptions are non-empty text: " + position);
                break;
        }
    }
    if (schema["type"]?.GetValue<string>() == "object")
        Check(schema["properties"] is JsonObject && schema["required"] is JsonArray, "Broad object schemas name their fields: " + position);
    // Value constraints live in descriptions, so every string or number value must describe its accepted values.
    if (schema["type"]?.GetValue<string>() is "string" or "number")
        Check(schema["description"] is JsonValue description && description.GetValueKind() == JsonValueKind.String,
            "Broad value schemas describe their accepted values: " + position);
}
foreach (var action in actionArguments.Keys) Broad(Serialized(action), action);
Console.WriteLine($"{checks} portable CUA checks passed");
