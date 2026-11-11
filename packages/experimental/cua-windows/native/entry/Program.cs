// The executable is a private helper launched by the dsh Windows provider.
using System.CommandLine;
using DeepSeek.Cua.Protocol;
using DeepSeek.Cua.Windows;

try
{
    if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041))
    {
        throw new NativeFailure("UNSUPPORTED", "Windows CUA requires Windows 10 build 19041 or later");
    }

    var serve = new Option<bool>("--serve") { Arity = ArgumentArity.Zero };
    var sharedServer = new Option<bool>("--shared-server") { Arity = ArgumentArity.Zero };
    var bridge = new Option<bool>("--bridge") { Arity = ArgumentArity.Zero };
    var instanceId = new Option<Guid>("--instance-id");
    var runtimeKey = new Option<string>("--runtime-key") { Required = true };
    var connectTimeoutMs = new Option<int>("--connect-timeout-ms") { Required = true };
    var graceMs = new Option<int>("--grace-ms") ;

    var rootCommand = new RootCommand
    {
        Options =
        {
            serve,
            sharedServer,
            bridge,
            instanceId,
            runtimeKey,
            connectTimeoutMs,
            graceMs,
        }
    };

    var parseResult = rootCommand.Parse(args);
    if (parseResult.Errors.Count != 0)
        throw new NativeFailure("INVALID_ARGUMENT", "The helper must be launched by the dsh Windows provider");

    var runtime = Applications.Digest(Environment.ProcessPath!);
    if (runtime != parseResult.GetValue(runtimeKey)) throw new NativeFailure("NATIVE_STARTUP", "The helper executable changed before startup");

    if (parseResult.GetValue(sharedServer))
        SharedRuntime.Serve(runtime, parseResult.GetRequiredValue(connectTimeoutMs), parseResult.GetRequiredValue(graceMs));
    else if (parseResult.GetValue(bridge))
        await SharedRuntime.Bridge(runtime, parseResult.GetRequiredValue(connectTimeoutMs));
    else if (parseResult.GetValue(serve))
        await SharedRuntime.Connect(parseResult.GetRequiredValue(instanceId).ToString("N"), runtime, parseResult.GetRequiredValue(connectTimeoutMs), parseResult.GetRequiredValue(graceMs));
    else
        throw new NativeFailure("INVALID_ARGUMENT", "The helper must be launched by the dsh Windows provider");

    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error is NativeFailure failure ? $"{failure.Code}: {failure.Message}" : $"NATIVE_STARTUP: {error.Message}");
    return -1;
}
