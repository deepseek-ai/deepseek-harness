// Read only public material through the existing SafeNet CSP. No authentication or key mutation APIs.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DshTokenPublicKey
{
    public const string Provider = "eToken Base Cryptographic Provider";
    public const uint PublicContextFlags = 0xF0000040; // CRYPT_VERIFYCONTEXT | CRYPT_SILENT
    public const int NoKey = unchecked((int)0x8009000D);

    public interface IApi
    {
        int Acquire(string container, out IntPtr context);
        int GetKey(IntPtr context, uint spec, out IntPtr key);
        int Export(IntPtr key, byte[] bytes, ref uint length);
        bool Destroy(IntPtr key);
        bool Release(IntPtr context);
    }

    public sealed class NativeApi : IApi
    {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        static extern bool CryptAcquireContextW(out IntPtr context, string container, string provider, uint type, uint flags);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool CryptGetUserKey(IntPtr context, uint spec, out IntPtr key);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool CryptExportKey(IntPtr key, IntPtr exportKey, uint type, uint flags, byte[] bytes, ref uint length);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool CryptDestroyKey(IntPtr key);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool CryptReleaseContext(IntPtr context, uint flags);
        public int Acquire(string container, out IntPtr context) {
            return CryptAcquireContextW(out context, container, Provider, 1, PublicContextFlags) ? 0 : Marshal.GetLastWin32Error();
        }
        public int GetKey(IntPtr context, uint spec, out IntPtr key) {
            return CryptGetUserKey(context, spec, out key) ? 0 : Marshal.GetLastWin32Error();
        }
        public int Export(IntPtr key, byte[] bytes, ref uint length) {
            return CryptExportKey(key, IntPtr.Zero, 6, 0, bytes, ref length) ? 0 : Marshal.GetLastWin32Error(); // PUBLICKEYBLOB
        }
        public bool Destroy(IntPtr key) { return CryptDestroyKey(key); }
        public bool Release(IntPtr context) { return CryptReleaseContext(context, 0); }
    }

    public sealed class Result
    {
        public string status = "unknown";
        public string[] publicKeys = new string[0];
    }

    // The adapter seam allows all failure paths to be exercised without loading a hardware provider.
    public static Result Read(IApi api, string container)
    {
        var result = new Result();
        IntPtr context;
        int error = api.Acquire(container, out context);
        if (error != 0) {
            if (error == unchecked((int)0x80090013) || error == unchecked((int)0x80090017)
                || error == unchecked((int)0x8009001E)) result.status = "provider-unavailable";
            else if (error == unchecked((int)0x80090016)) result.status = "container-unavailable";
            return result;
        }
        try {
            var keys = new List<string>();
            foreach (uint spec in new uint[] { 2, 1 }) {
                IntPtr key;
                error = api.GetKey(context, spec, out key);
                if (error == NoKey) continue;
                if (error != 0) return result;
                bool destroyed;
                try {
                    uint length = 0;
                    if (api.Export(key, null, ref length) != 0 || length < 20 || length > 16384) return result;
                    var bytes = new byte[length];
                    uint capacity = length;
                    if (api.Export(key, bytes, ref length) != 0 || length < 20 || length > capacity) return result;
                    keys.Add(Convert.ToBase64String(bytes, 0, (int)length));
                } finally { destroyed = api.Destroy(key); }
                if (!destroyed) return result;
            }
            if (keys.Count > 0) {
                result.publicKeys = keys.ToArray();
                result.status = "public-keys";
            }
        } finally {
            if (!api.Release(context)) {
                result.status = "unknown";
                result.publicKeys = new string[0];
            }
        }
        return result;
    }
}
