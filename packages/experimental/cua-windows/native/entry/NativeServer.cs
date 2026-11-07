// The per-user service serves isolated Agent connections and Host leases on a private named pipe.
using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text.Json;
using System.Windows.Automation;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal static class NativeServer
{
    [DoesNotReturn]
    internal static void Fatal(string code, string message)
    {
        Console.Error.WriteLine($"{code}: {message}; native handles are no longer usable");
        Environment.Exit(70);
        throw new InvalidOperationException("Process exit returned");
    }

    internal static async Task Run(string instance, string expectedRuntime, int connectTimeoutMs, int graceMs)
    {
        if (!Guid.TryParseExact(instance, "N", out _)) throw new NativeFailure("INVALID_ARGUMENT", "A Host instance identifier is required");
        var executable = Environment.ProcessPath ?? throw new NativeFailure("NATIVE_STARTUP", "The executable identity is unavailable");
        using var source = File.OpenRead(executable);
        var runtime = Convert.ToHexStringLower(SHA256.HashData(source));
        if (runtime != expectedRuntime) throw new NativeFailure("NATIVE_STARTUP", "The helper executable changed before startup");
        var pipeName = SharedRuntime.PipeName(runtime);
        using var lifetime = new CancellationTokenSource();
        lifetime.CancelAfter(connectTimeoutMs);
        await using var mta = new MtaDispatcher();
        await using var sta = new StaDispatcher();
        await sta.Invoke(() => { }, lifetime.Token);
        await mta.Invoke(() => true, lifetime.Token);
        await using var executor = new DesktopExecutor(mta, sta);
        var clients = new ConcurrentDictionary<Task, byte>();
        NamedPipeServerStream? listener = NewPipe(pipeName);
        var membership = new object();
        var connections = 0;
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                await listener.WaitForConnectionAsync(lifetime.Token);
                var connected = listener;
                lock (membership)
                {
                    lifetime.Token.ThrowIfCancellationRequested();
                    connections++;
                    lifetime.CancelAfter(Timeout.Infinite);
                }
                listener = NewPipe(pipeName);
                var task = Serve(connected, executor, instance, runtime, connectTimeoutMs, lifetime.Token);
                clients.TryAdd(task, 0);
                _ = task.ContinueWith(completed =>
                {
                    clients.TryRemove(completed, out _);
                    if (completed.IsFaulted) { _ = completed.Exception; Console.Error.WriteLine("NATIVE_CONNECTION: Connection cleanup failed"); }
                    lock (membership) { if (--connections == 0) lifetime.Cancel(); }
                }, CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            }
        }
        catch (OperationCanceledException error) when (lifetime.IsCancellationRequested) { _ = error; /* Host shutdown cancels the pending read. */ }
        finally
        {
            lifetime.Cancel();
            listener?.Dispose();
            await Task.WhenAll(clients.Keys);
        }
    }

    private static NamedPipeServerStream NewPipe(string name) => new(name, PipeDirection.InOut,
        NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);

    private static async Task Serve(NamedPipeServerStream pipe, DesktopExecutor executor,
        string instance, string runtime, int connectTimeoutMs, CancellationToken serverLifetime)
    {
        using (pipe)
        using (var lifetime = CancellationTokenSource.CreateLinkedTokenSource(serverLifetime))
        using (var writer = new SemaphoreSlim(1))
        {
            var state = new ClientState();
            Task? active = null;
            CancellationTokenSource? cancellation = null;
            string? latestRequestId = null;
            var closeRequested = false;
            var cleanupTimeoutMs = connectTimeoutMs;
            try
            {
                var reader = new FrameReader(pipe);
                string? line;
                using (var greeting = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
                {
                    greeting.CancelAfter(connectTimeoutMs);
                    line = await reader.ReadAsync(8192, greeting.Token) ?? throw new NativeFailure("INVALID_REQUEST", "A native hello is required");
                }
                var hello = WireJson.Parse(line);
                if (hello.ValueKind == JsonValueKind.Object && hello.EnumerateObject().Select(item => item.Name).Order().SequenceEqual(["runtimeKey", "type"])
                    && hello.GetProperty("type").GetString() == "lease" && hello.GetProperty("runtimeKey").GetString() == runtime)
                {
                    await Write(pipe, writer, new { type = "ready", protocol = 1, runtimeKey = runtime, pid = Environment.ProcessId, instanceId = instance },
                        8192, connectTimeoutMs, lifetime.Token);
                    if (await reader.ReadAsync(8192, lifetime.Token) is not null) throw new NativeFailure("INVALID_REQUEST", "A service lease cannot send desktop operations");
                    return;
                }
                if (hello.ValueKind != JsonValueKind.Object || hello.EnumerateObject().Select(item => item.Name).Order().SequenceEqual(["config", "protocol", "runtimeKey", "type"]) == false
                    || hello.GetProperty("type").GetString() != "hello" || hello.GetProperty("protocol").GetInt32() != 1 || hello.GetProperty("runtimeKey").GetString() != runtime)
                    throw new NativeFailure("INVALID_REQUEST", "The native handshake did not match this helper");
                var config = NativeConfig.Parse(hello.GetProperty("config"));
                cleanupTimeoutMs = config.GraceMs;
                await Write(pipe, writer, new { type = "ready", protocol = 1, runtimeKey = runtime, pid = Environment.ProcessId, instanceId = instance }, 8192, config.GraceMs, lifetime.Token);
                while ((line = await reader.ReadAsync(config.MaxRequestBytes, lifetime.Token)) is not null)
                {
                    var value = WireJson.Parse(line);
                    if (value.ValueKind == JsonValueKind.Object && value.TryGetProperty("type", out _))
                    {
                        var control = NativeControlFrame.Parse(value, latestRequestId, active?.IsCompleted != false);
                        if (control == NativeControl.Close) { closeRequested = true; break; }
                        if (control == NativeControl.Cancel) cancellation!.Cancel();
                        continue;
                    }
                    var request = NativeRequest.Parse(value);
                    if (active is { IsCompleted: false }) throw new NativeFailure("NATIVE_BUSY", "Native requests must be sequential");
                    if (active is not null) await active;
                    cancellation?.Dispose();
                    cancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                    cancellation.CancelAfter(request.Method == "screenshot" ? Math.Min(config.TimeoutMs, config.ScreenshotTimeoutMs) : config.TimeoutMs);
                    latestRequestId = request.Id;
                    active = Dispatch(request, state, executor, config, pipe, writer, cancellation.Token, lifetime.Token);
                }
            }
            catch (Exception error)
            {
                if (error is not (IOException or OperationCanceledException)) Console.Error.WriteLine($"NATIVE_CONNECTION: {error.GetType().Name}");
            }
            finally
            {
                lifetime.Cancel();
                cancellation?.Cancel();
                if (active is not null)
                {
                    try { await active; }
                    catch (Exception error) { Console.Error.WriteLine($"NATIVE_CONNECTION: {error.GetType().Name}"); }
                }
                cancellation?.Dispose();
                state.Clear();
                if (closeRequested)
                    await Write(pipe, writer, new { type = "closed" }, 8192, cleanupTimeoutMs, CancellationToken.None);
            }
        }
    }

    private static async Task Dispatch(NativeRequest request, ClientState state, DesktopExecutor executor, NativeConfig config,
        Stream pipe, SemaphoreSlim writer, CancellationToken cancellation, CancellationToken connection)
    {
        var operation = executor.Execute(request, state, config, cancellation);
        using var monitorStop = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        var monitor = WatchOperation(operation, monitorStop.Token, config.GraceMs);
        object response;
        try { response = new { id = request.Id, result = await operation }; }
        catch (OperationCanceledException) { response = Failure(request.Id, "NATIVE_CANCELLED", "Native operation cancelled; observe before deciding on further input"); }
        catch (NativeFailure error) { response = Failure(request.Id, error.Code, error.Message); }
        catch (NotImplementedException error) { response = Failure(request.Id, "NOT_IMPLEMENTED", error.Message); }
        catch (ElementNotAvailableException) { response = Failure(request.Id, "STALE_SNAPSHOT", "An accessibility element disappeared; read fresh state"); }
        catch (ElementNotEnabledException) { response = Failure(request.Id, "ELEMENT_DISABLED", "The selected control is disabled"); }
        catch (UnauthorizedAccessException) { response = Failure(request.Id, "PERMISSION_DENIED", "Windows refused access to the selected application"); }
        catch (Exception error) { response = Failure(request.Id, "NATIVE_OPERATION", $"Windows operation failed (0x{error.HResult:X8}); observe before retrying"); }
        finally { monitorStop.Cancel(); await monitor; }
        var bytes = JsonSerializer.SerializeToUtf8Bytes(response, WireJson.Options);
        if (bytes.Length + 1 > config.MaxResponseBytes) response = Failure(request.Id, "NATIVE_RESPONSE_LIMIT", "Native response exceeded its configured byte limit");
        await Write(pipe, writer, response, config.MaxResponseBytes, config.GraceMs, connection);
    }

    private static object Failure(string id, string code, string message) => new { id, error = new { code, message } };

    private static async Task WatchOperation(Task operation, CancellationToken cancellation, int graceMs)
    {
        await Task.WhenAny(operation, Task.Delay(Timeout.Infinite, cancellation));
        if (operation.IsCompleted) return;
        try { await operation.WaitAsync(TimeSpan.FromMilliseconds(graceMs)); }
        catch (TimeoutException) { Fatal("NATIVE_CLEANUP", "A cancelled desktop operation did not stop before the grace deadline"); }
        catch (Exception error) when (operation.IsCompleted) { _ = error; /* Dispatch owns the operation result. */ }
    }

    private static async Task Write(Stream pipe, SemaphoreSlim writer, object value, int maximum, int timeoutMs, CancellationToken cancellation)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value, WireJson.Options);
        if (bytes.Length + 1 > maximum) throw new NativeFailure("NATIVE_RESPONSE_LIMIT", "The native frame exceeds its byte limit");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(timeoutMs);
        await writer.WaitAsync(deadline.Token);
        try { await pipe.WriteAsync(bytes, deadline.Token); await pipe.WriteAsync("\n"u8.ToArray(), deadline.Token); await pipe.FlushAsync(deadline.Token); }
        finally { writer.Release(); }
    }
}
