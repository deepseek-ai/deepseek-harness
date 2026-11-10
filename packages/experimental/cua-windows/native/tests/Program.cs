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
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"one","method":"click","params":{"appHandle":"app","windowId":"1","x":-1,"y":2}}""")), "INVALID_ARGUMENT");
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"one","method":"getState","params":{"appHandle":"app","maxElements":0,"maxDepth":5}}""")), "INVALID_ARGUMENT");
Refuses(() => NativeRequest.Parse(WireJson.Parse("""{"id":"one","method":"typeText","params":{"appHandle":"app","text":"hello","unowned":1}}""")), "INVALID_ARGUMENT");
Refuses(() => WireJson.Parse("""{"id":"one","id":"two"}"""), "INVALID_REQUEST");
Refuses(() => WireJson.Parse("""{"params":{"x":1,"x":2}}"""), "INVALID_REQUEST");
Check(NativeRequest.Parse(WireJson.Parse("""{"id":"launch","method":"launchApp","params":{"appHandle":"pending"}}""")).Method == "launchApp", "Host launch continuation remains admitted");

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

var node = new AccessibilityNode { Role = "AXTextField", Name = "Title", Value = "", HasValue = true, Placeholder = "Title", ValueWritable = "true", Actions = ["Press", "Focus"] };
var text = AccessibilityText.Format(node, 3, false);
Check(text.Contains("= \"\" placeholder=\"Title\""), "Empty values and placeholders remain distinct");
Check(!text.Contains("\"Press\"") && text.Contains("\"Focus\""), "Common actions compact without hiding secondary actions");
Check(AccessibilityText.Format(node, 3, true).Contains("\"Press\""), "Details retain complete action names");
Check(!AccessibilityText.Retain(new() { Role = "AXGroup" }), "Empty structural containers can collapse");
Check(AccessibilityText.Retain(new() { Role = "AXGroup", Actions = ["Copy"] }), "Actionable containers retain their row");
Check(AccessibilityText.Format(new() { Role = "AXTextArea", Value = "abc", HasValue = true, HasSelection = true, Selection = new(2, 5) }, 0, false)
    .Contains("selection=unavailable"), "Out-of-range selections do not describe valid text");
Console.WriteLine($"{checks} portable CUA checks passed");
