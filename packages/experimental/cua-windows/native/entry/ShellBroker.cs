// Explorer owns user-launched applications, independently of the helper's managed process Job.
using System.Reflection;
using System.Runtime.InteropServices;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal static class ShellBroker
{
    internal static void Launch(string path, string arguments = "", int show = 4)
    {
        var owned = new List<object>();
        T Own<T>(T value) where T : class { owned.Add(value); return value; }
        try
        {
            dynamic windows = Own(Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39"), true)!)!);
            object location = 0, root = null!;
            int handle;
            object desktop = Own((object)windows.FindWindowSW(ref location, ref root, 8, out handle, 1));
            var service = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
            var browserId = typeof(IShellBrowser).GUID;
            Marshal.ThrowExceptionForHR(((IServiceProvider)desktop).QueryService(ref service, ref browserId, out var rawBrowser));
            var browser = (IShellBrowser)Own(rawBrowser);
            Marshal.ThrowExceptionForHR(browser.QueryActiveShellView(out var view));
            Own(view);
            var dispatchId = new Guid("00020400-0000-0000-C000-000000000046");
            Marshal.ThrowExceptionForHR(view.GetItemObject(0, ref dispatchId, out var folder));
            Own(folder);
            var shell = Own(folder.GetType().InvokeMember("Application", BindingFlags.GetProperty, null, folder, null)!);
            shell.GetType().InvokeMember("ShellExecute", BindingFlags.InvokeMethod, null, shell,
                [path, arguments, Path.IsPathFullyQualified(path) ? Path.GetDirectoryName(path)! : "", "open", show]);
        }
        catch (Exception error) when (error is COMException or TargetInvocationException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
        {
            throw new NativeFailure("LAUNCH_FAILED", "Windows Explorer could not launch this executable; open the application and select its observed PID");
        }
        finally
        {
            var released = new HashSet<object>(ReferenceEqualityComparer.Instance);
            foreach (var value in owned.AsEnumerable().Reverse())
                if (released.Add(value) && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
        }
    }

    [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IServiceProvider
    {
        [PreserveSig] int QueryService(ref Guid service, ref Guid id, [MarshalAs(UnmanagedType.Interface)] out object value);
    }

    [ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellBrowser
    {
        [PreserveSig] int GetWindow(out nint window);
        [PreserveSig] int ContextSensitiveHelp([MarshalAs(UnmanagedType.Bool)] bool enter);
        [PreserveSig] int InsertMenusSB(nint menu, nint widths);
        [PreserveSig] int SetMenuSB(nint menu, nint holemenu, nint active);
        [PreserveSig] int RemoveMenusSB(nint menu);
        [PreserveSig] int SetStatusTextSB([MarshalAs(UnmanagedType.LPWStr)] string text);
        [PreserveSig] int EnableModelessSB([MarshalAs(UnmanagedType.Bool)] bool enable);
        [PreserveSig] int TranslateAcceleratorSB(nint message, ushort command);
        [PreserveSig] int BrowseObject(nint list, uint flags);
        [PreserveSig] int GetViewStateStream(uint mode, out nint stream);
        [PreserveSig] int GetControlWindow(uint id, out nint window);
        [PreserveSig] int SendControlMsg(uint id, uint message, nuint wparam, nint lparam, out nint result);
        [PreserveSig] int QueryActiveShellView(out IShellView view);
        [PreserveSig] int OnViewWindowActive(IShellView view);
        [PreserveSig] int SetToolbarItems(nint buttons, uint count, uint flags);
    }

    [ComImport, Guid("000214E3-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellView
    {
        [PreserveSig] int GetWindow(out nint window);
        [PreserveSig] int ContextSensitiveHelp([MarshalAs(UnmanagedType.Bool)] bool enter);
        [PreserveSig] int TranslateAccelerator(nint message);
        [PreserveSig] int EnableModeless([MarshalAs(UnmanagedType.Bool)] bool enable);
        [PreserveSig] int UIActivate(uint state);
        [PreserveSig] int Refresh();
        [PreserveSig] int CreateViewWindow(nint previous, nint settings, nint browser, nint bounds, out nint window);
        [PreserveSig] int DestroyViewWindow();
        [PreserveSig] int GetCurrentInfo(nint settings);
        [PreserveSig] int AddPropertySheetPages(uint reserved, nint callback, nint parameter);
        [PreserveSig] int SaveViewState();
        [PreserveSig] int SelectItem(nint list, uint flags);
        [PreserveSig] int GetItemObject(uint item, ref Guid id, [MarshalAs(UnmanagedType.Interface)] out object value);
    }

}
