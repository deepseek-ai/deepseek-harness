// The executable is a private helper launched by the dsh Windows provider.
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041)) throw new NativeFailure("UNSUPPORTED", "Windows CUA requires Windows 10 build 19041 or later");
            var server = args.Length == 7 && args[0] == "--shared-server";
            var bridge = args.Length == 7 && args[0] == "--bridge";
            var connector = args.Length == 9 && args[0] == "--serve" && args[1] == "--instance-id" && Guid.TryParseExact(args[2], "N", out _);
            var offset = server || bridge ? 1 : 3;
            if ((!server && !connector && !bridge) || args[offset] != "--runtime-key" || args[offset + 2] != "--connect-timeout-ms"
                || args[offset + 4] != "--grace-ms"
                || !int.TryParse(args[offset + 3], out var connectTimeoutMs) || connectTimeoutMs <= 0
                || !int.TryParse(args[offset + 5], out var graceMs) || graceMs <= 0)
                throw new NativeFailure("INVALID_ARGUMENT", "The helper must be launched by the dsh Windows provider");
            var runtime = Applications.Digest(Environment.ProcessPath!);
            if (runtime != args[offset + 1]) throw new NativeFailure("NATIVE_STARTUP", "The helper executable changed before startup");
            if (server) SharedRuntime.Serve(runtime, connectTimeoutMs, graceMs);
            else if (bridge) SharedRuntime.Bridge(runtime, connectTimeoutMs).GetAwaiter().GetResult();
            else SharedRuntime.Connect(args[2], runtime, connectTimeoutMs, graceMs).GetAwaiter().GetResult();
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error is NativeFailure failure ? $"{failure.Code}: {failure.Message}" : $"NATIVE_STARTUP: {error.Message}");
            return 1;
        }
    }
}
