// A managed Host connector leases an Explorer-launched service outside the Host's kill-on-close Job.
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal static class SharedRuntime
{
    internal static string PipeName(string runtime)
    {
        using var identity = WindowsIdentity.GetCurrent();
        using var process = Process.GetCurrentProcess();
        var user = identity.User?.Value ?? throw new NativeFailure("NATIVE_STARTUP", "The Windows user identity is unavailable");
        var scope = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes($"{user}:{process.SessionId}")));
        return $"dsh-cua-{scope}-{runtime}";
    }

    internal static async Task Connect(string launcherId, string runtime, int timeoutMs, int graceMs)
    {
        using var deadline = new CancellationTokenSource(timeoutMs);
        using var pipe = new NamedPipeClientStream(".", PipeName(runtime), PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try { pipe.Connect(0); }
        catch (TimeoutException)
        {
            await using var sta = new StaDispatcher();
            var executable = Environment.ProcessPath!;
            await sta.Invoke(() => ShellBroker.Launch(executable,
                $"--shared-server --runtime-key {runtime} --connect-timeout-ms {timeoutMs} --grace-ms {graceMs}", 0), deadline.Token);
            await pipe.ConnectAsync(deadline.Token);
        }
        var pid = VerifyServer(pipe, runtime);
        var hello = JsonSerializer.SerializeToUtf8Bytes(new { type = "lease", runtimeKey = runtime }, WireJson.Options);
        await pipe.WriteAsync(hello, deadline.Token);
        await pipe.WriteAsync("\n"u8.ToArray(), deadline.Token);
        var reader = new FrameReader(pipe);
        var line = await reader.ReadAsync(8192, deadline.Token)
            ?? throw new NativeFailure("NATIVE_EOF", "The shared service exited during connection");
        var ready = WireJson.Parse(line);
        if (ready.GetProperty("runtimeKey").GetString() != runtime || ready.GetProperty("pid").GetInt32() != pid)
            throw new NativeFailure("NATIVE_PROTOCOL", "The shared service returned a different process identity");
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            type = "ready", protocol = 1, runtimeKey = runtime, pid,
            instanceId = ready.GetProperty("instanceId").GetString(), launcherId, endpoint = @"\\.\pipe\" + PipeName(runtime),
        }, WireJson.Options));
        await Console.Out.FlushAsync();
        // Console.In's synchronized reader can block before it returns an asynchronous result.
        var parent = Task.Run(() => Console.In.ReadLine());
        var stopped = reader.ReadAsync(8192, CancellationToken.None);
        if (await Task.WhenAny(parent, stopped) == stopped)
            throw new NativeFailure("NATIVE_EXITED", "The shared desktop service stopped; select applications again");
        await parent;
    }

    // Windows owns the named pipe; WSL forwards the unchanged protocol over standard streams.
    internal static async Task Bridge(string runtime, int timeoutMs)
    {
        using var deadline = new CancellationTokenSource(timeoutMs);
        using var pipe = new NamedPipeClientStream(".", PipeName(runtime), PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(deadline.Token);
        VerifyServer(pipe, runtime);
        using var input = Console.OpenStandardInput();
        using var output = Console.OpenStandardOutput();
        // Inherited standard-input handles can be synchronous; never block pipe output on their reads.
        var upload = Task.Run(() => input.CopyToAsync(pipe));
        var download = pipe.CopyToAsync(output);
        try
        {
            var completed = await Task.WhenAny(upload, download);
            await completed;
            await output.FlushAsync();
        }
        finally
        {
            // Process exit ends a pending synchronous stdin read; it must not delay pipe cleanup.
            pipe.Dispose();
        }
    }

    private static uint VerifyServer(NamedPipeClientStream pipe, string runtime)
    {
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var pid))
            throw new NativeFailure("NATIVE_PROTOCOL", "The Windows pipe server identity is unavailable");
        var server = Applications.Running(checked((int)pid));
        if (Applications.Digest(server.Path) != runtime)
            throw new NativeFailure("NATIVE_PROTOCOL", "The Windows pipe belongs to another executable");
        return pid;
    }

    internal static void Serve(string runtime, int timeoutMs, int graceMs)
    {
        using var mutex = new Mutex(false, PipeName(runtime), new NamedWaitHandleOptions { CurrentUserOnly = true, CurrentSessionOnly = true });
        bool acquired;
        try { acquired = mutex.WaitOne(0); }
        catch (AbandonedMutexException) { acquired = true; }
        if (!acquired) return;
        try { NativeServer.Run(Guid.NewGuid().ToString("N"), runtime, timeoutMs, graceMs).GetAwaiter().GetResult(); }
        finally { mutex.ReleaseMutex(); }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint serverProcessId);
}
