namespace DeepSeek.Cua.Windows;

internal sealed class WindowCapture
{
    internal Task<object> Capture(AppState app, WindowState window, RequestContext context)
        => throw new NotImplementedException("Windows screenshots are not implemented.");
}
