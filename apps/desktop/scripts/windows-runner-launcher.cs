// Compiled as a Windows GUI executable so Task Scheduler never allocates a console.
using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

internal static class WindowsRunnerLauncher
{
    private static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        var owner = Process.GetCurrentProcess();
        string log = Path.Combine(root, "launcher-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffZ") + "-" + owner.Id + "-" + Guid.NewGuid().ToString("N"));
        try
        {
            File.WriteAllText(Path.Combine(root, "process.json"), "{\"Pid\":" + owner.Id + ",\"Started\":" + owner.StartTime.ToUniversalTime().Ticks + "}");
            if (args.Length != 1 || !Path.IsPathRooted(args[0]))
                throw new ArgumentException("Expected the absolute PowerShell executable path.");
            using (var output = File.Create(log + ".out.log"))
            using (var errors = File.Create(log + ".err.log"))
            using (var child = new Process())
            {
                child.StartInfo = new ProcessStartInfo
                {
                    FileName = args[0],
                    Arguments = "-NoProfile -NonInteractive -File \"" + Path.Combine(root, "run.ps1") + "\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                child.Start();
                Task stdout = child.StandardOutput.BaseStream.CopyToAsync(output);
                Task stderr = child.StandardError.BaseStream.CopyToAsync(errors);
                child.WaitForExit();
                // Descendants can retain inherited pipe writers after the direct child exits.
                if (!Task.WaitAll(new[] { stdout, stderr }, TimeSpan.FromSeconds(5)))
                {
                    File.WriteAllText(log + ".drain.log", "Output drain timed out after child exit " + child.ExitCode + "; launcher logs may be incomplete. Periodic recovery remains governed by the restart budget.");
                    // Process exit releases pipe reads still held by background copy tasks.
                    return 5;
                }
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            // Launcher exceptions disable periodic starts, including failures before run.ps1 can consume its budget.
            int result = 2;
            try { DisableTask(root); }
            catch (Exception disableError) { error = new AggregateException(error, disableError); result = 4; }
            try { File.AppendAllText(log + ".err.log", error.ToString() + Environment.NewLine); }
            catch (Exception)
            {
                // No console is available. Task Scheduler result 3 reports that diagnostics could not be written.
                return result == 4 ? 4 : 3;
            }
            return result;
        }
    }

    private static void DisableTask(string root)
    {
        // Keep task identity aligned with windows-runner-task.ps1 and run-windows-runner-task.ps1.
        string runner = Directory.GetParent(root.TrimEnd(Path.DirectorySeparatorChar)).FullName.TrimEnd('\\', '/');
        string taskName;
        using (var hash = SHA256.Create())
            taskName = "DSH-Packaging-" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(runner.ToUpperInvariant()))).Replace("-", "").Substring(0, 16);
        dynamic scheduler = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
        scheduler.Connect();
        scheduler.GetFolder("\\").GetTask(taskName).Enabled = false;
    }
}
