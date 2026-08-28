using System;
using System.Diagnostics;
using System.IO;

namespace AtomEons.OrangeFive.Runtime
{
    internal static class OrangeFiveHiddenLauncher
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string distDirectory = AppDomain.CurrentDomain.BaseDirectory;
            string orangeRoot = Path.GetFullPath(Path.Combine(distDirectory, ".."));
            bool runtimeMode = args.Length == 0;
            string workerPath = runtimeMode
                ? Path.Combine(distDirectory, "orange5-runtime-worker.exe")
                : Path.GetFullPath(args[0]);
            string workerArguments = args.Length > 1 ? QuoteArgument(args[1]) : String.Empty;
            string workingDirectory = args.Length > 2 ? Path.GetFullPath(args[2]) : orangeRoot;

            if (!File.Exists(workerPath))
            {
                return 2;
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = workerPath,
                Arguments = workerArguments,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                ErrorDialog = false
            };
            if (runtimeMode)
            {
                startInfo.EnvironmentVariables["ORANGE5_ROOT"] = orangeRoot;
            }

            using (Process worker = Process.Start(startInfo))
            {
                if (worker == null)
                {
                    return 3;
                }

                worker.WaitForExit();
                return worker.ExitCode;
            }
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
