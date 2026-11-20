// The per-user service serves isolated Agent connections and Host leases on a private named pipe.
using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text.Json;
using System.Windows.Automation;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal static class NativeServer
{
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
        NamedPipeServerStream? listener = null;
        var membership = new object();
        var connections = 0;
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                try
                {
                    listener ??= NewPipe(pipeName);
                    await listener.WaitForConnectionAsync(lifetime.Token);
                }
                catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { break; }
                catch (Exception error)
                {
                    Report("NATIVE_LISTENER", error);
                    try { listener?.Dispose(); }
                    catch (Exception cleanupError) { Report("NATIVE_CONNECTION", cleanupError); }
                    listener = null;
                    await Task.Delay(graceMs, lifetime.Token);
                    continue;
                }
                var connected = listener;
                lock (membership)
                {
                    lifetime.Token.ThrowIfCancellationRequested();
                    connections++;
                    lifetime.CancelAfter(Timeout.Infinite);
                }
                listener = null;
                var task = Serve(connected, executor, instance, runtime, connectTimeoutMs, lifetime.Token);
                clients.TryAdd(task, 0);
                _ = task.ContinueWith(completed =>
                {
                    clients.TryRemove(completed, out _);
                    if (completed.IsFaulted) Report("NATIVE_CONNECTION", completed.Exception!);
                    lock (membership) { if (--connections == 0) lifetime.CancelAfter(connectTimeoutMs); }
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

    private static void Report(string code, Exception error)
    {
        try { Console.Error.WriteLine($"{code}: {error.GetType().Name}"); }
        catch (Exception reportError) when (reportError is IOException or ObjectDisposedException)
        {
            _ = reportError; // A disconnected diagnostic stream must not stop the shared service.
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
            TaskCompletionSource? replying = null;
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
                    if (active is { IsCompleted: false } && replying?.Task.IsCompleted != true)
                    {
                        await Write(pipe, writer, Failure(request.Id, "NATIVE_BUSY", "The previous native operation has not stopped; do not send further input until it finishes"),
                            config.MaxResponseBytes, config.GraceMs, lifetime.Token);
                        continue;
                    }
                    if (active is not null) await active;
                    cancellation?.Dispose();
                    cancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                    cancellation.CancelAfter(request.Method == "screenshot" ? Math.Min(config.TimeoutMs, config.ScreenshotTimeoutMs) : config.TimeoutMs);
                    latestRequestId = request.Id;
                    replying = new(TaskCreationOptions.RunContinuationsAsynchronously);
                    active = Dispatch(request, state, executor, config, pipe, writer, replying, cancellation.Token, lifetime.Token);
                }
            }
            catch (Exception error)
            {
                if (error is not (IOException or OperationCanceledException)) Report("NATIVE_CONNECTION", error);
            }
            finally
            {
                lifetime.Cancel();
                cancellation?.Cancel();
                try
                {
                    if (active is not null) await active;
                }
                catch (NativeFailure error) when (error.Code == "NATIVE_CLEANUP") { throw; }
                catch (Exception error) { Report("NATIVE_CONNECTION", error); }
                finally
                {
                    cancellation?.Dispose();
                    await executor.ReleaseConnection(state, cleanupTimeoutMs);
                }
                state.Clear();
                if (closeRequested)
                    await Write(pipe, writer, new { type = "closed" }, 8192, cleanupTimeoutMs, CancellationToken.None);
            }
        }
    }

    private static async Task Dispatch(NativeRequest request, ClientState state, DesktopExecutor executor, NativeConfig config,
        Stream pipe, SemaphoreSlim writer, TaskCompletionSource replying, CancellationToken cancellation, CancellationToken connection)
    {
        var operationStop = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        var failure = new TaskCompletionSource<NativeFailure>(TaskCreationOptions.RunContinuationsAsynchronously);
        // A synchronous native call must not block the pipe reader or its timeout response.
        var operation = Task.Run(() => executor.Execute(request, state, config, operationStop.Token,
            error => { failure.TrySetResult(error); }));
        object response;
        try
        {
            try { response = new { id = request.Id, result = await WatchOperation(operation, failure.Task, operationStop.Token, config.GraceMs) }; }
            catch (OperationCanceledException) { response = Failure(request.Id, "NATIVE_CANCELLED", "Native operation cancelled; observe before deciding on further input"); }
            catch (NativeFailure error)
            {
                if (error.Code is "AX_TIMEOUT" or "NATIVE_CLEANUP") operationStop.Cancel();
                response = Failure(request.Id, error.Code, error.Message);
            }
            catch (NotImplementedException error) { response = Failure(request.Id, "NOT_IMPLEMENTED", error.Message); }
            catch (ElementNotAvailableException) { response = Failure(request.Id, "STALE_SNAPSHOT", "An accessibility element disappeared; read fresh state"); }
            catch (ElementNotEnabledException) { response = Failure(request.Id, "ELEMENT_DISABLED", "The selected control is disabled"); }
            catch (UnauthorizedAccessException) { response = Failure(request.Id, "PERMISSION_DENIED", "Windows refused access to the selected application"); }
            catch (Exception error) { response = Failure(request.Id, "NATIVE_OPERATION", $"Windows operation failed (0x{error.HResult:X8}); observe before retrying"); }
        }
        finally
        {
            try { await operation.WaitAsync(TimeSpan.FromMilliseconds(config.GraceMs)); }
            catch (TimeoutException) when (!operation.IsCompleted)
            {
                throw new NativeFailure("NATIVE_CLEANUP", "The native operation did not stop before the cleanup deadline; its outcome is unknown");
            }
            catch (Exception error) { _ = error; /* The operation failure has already been reported to the caller. */ }
            finally
            {
                // A late native call still owns its cancellation token; observe its eventual failure.
                _ = operation.ContinueWith(completed =>
                {
                    _ = completed.Exception;
                    operationStop.Dispose();
                }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            }
        }
        replying.SetResult();
        var bytes = JsonSerializer.SerializeToUtf8Bytes(response, WireJson.Options);
        if (bytes.Length + 1 > config.MaxResponseBytes) response = Failure(request.Id, "NATIVE_RESPONSE_LIMIT", "Native response exceeded its configured byte limit");
        await Write(pipe, writer, response, config.MaxResponseBytes, config.GraceMs, connection);
    }

    private static object Failure(string id, string code, string message) => new { id, error = new { code, message } };

    private static async Task<object> WatchOperation(Task<object> operation, Task<NativeFailure> failure,
        CancellationToken cancellation, int graceMs)
    {
        var completed = Task.WhenAny(operation, failure);
        try { await completed.WaitAsync(cancellation); }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            try { await completed.WaitAsync(TimeSpan.FromMilliseconds(graceMs)); }
            catch (TimeoutException)
            {
                throw new NativeFailure("NATIVE_CLEANUP", "A cancelled desktop operation did not stop before the grace deadline; its outcome is unknown");
            }
        }
        if (failure.IsCompleted) throw await failure;
        return await operation;
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
