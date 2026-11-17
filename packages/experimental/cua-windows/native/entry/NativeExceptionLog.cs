// Shared-server exception diagnostics remain readable beside the helper executable.
using System.Runtime.ExceptionServices;
using System.Text;

namespace DeepSeek.Cua.Windows;

internal sealed class NativeExceptionLog : IDisposable
{
    private readonly string path = Path.Combine(AppContext.BaseDirectory, "dsh-cua-windows.log");
    private readonly object gate = new();
    private bool writing;
    private bool disposed;

    internal NativeExceptionLog()
    {
        AppDomain.CurrentDomain.FirstChanceException += FirstChance;
        AppDomain.CurrentDomain.UnhandledException += Unhandled;
        Write("Startup", $"Shared server PID {Environment.ProcessId}");
    }

    private void FirstChance(object? sender, FirstChanceExceptionEventArgs args)
        => Write("FirstChanceException", args.Exception);

    private void Unhandled(object? sender, UnhandledExceptionEventArgs args)
        => Write($"UnhandledException (terminating={args.IsTerminating})", args.ExceptionObject);

    private void Write(string kind, object value)
    {
        lock (gate)
        {
            // First-chance notifications also fire for failures while formatting or writing this log.
            if (disposed || writing) return;
            writing = true;
            try
            {
                var entry = $"[{DateTimeOffset.UtcNow:O}] {kind} PID={Environment.ProcessId} Thread={Environment.CurrentManagedThreadId}{Environment.NewLine}{value.ToString()}{Environment.NewLine}";
                File.AppendAllText(path, entry, Encoding.UTF8);
            }
            catch (Exception error)
            {
                try { Console.Error.WriteLine($"NATIVE_LOG: Could not append to {path}: {error}"); }
                catch (Exception diagnosticError) { _ = diagnosticError; /* Diagnostic failures must not escape an exception event handler. */ }
            }
            finally { writing = false; }
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            AppDomain.CurrentDomain.FirstChanceException -= FirstChance;
            AppDomain.CurrentDomain.UnhandledException -= Unhandled;
        }
    }
}
