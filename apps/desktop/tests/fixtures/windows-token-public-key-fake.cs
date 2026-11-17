
public sealed class FakeTokenPublicKey : DshTokenPublicKey.IApi
{
    string scenario;
    int releases, destroys, exports, keys;
    public FakeTokenPublicKey(string value) { scenario = value; }
    public int Acquire(string container, out System.IntPtr context) {
        if (container != "fake-container") throw new System.Exception("unexpected container");
        context = new System.IntPtr(1);
        if (scenario == "provider") return unchecked((int)0x80090013);
        if (scenario == "container") return unchecked((int)0x80090016);
        if (scenario == "auth") return unchecked((int)0x80090022);
        return 0;
    }
    public int GetKey(System.IntPtr context, uint spec, out System.IntPtr key) {
        keys++;
        key = new System.IntPtr(2);
        if (scenario == "no-key" || spec == 1) return DshTokenPublicKey.NoKey;
        if (scenario == "get-key") return 5;
        return 0;
    }
    public int Export(System.IntPtr key, byte[] bytes, ref uint length) {
        exports++;
        if (scenario == "export") return 5;
        if (scenario == "size") { length = 1000000; return 0; }
        length = 24;
        return 0;
    }
    public bool Destroy(System.IntPtr key) { destroys++; return scenario != "destroy"; }
    public bool Release(System.IntPtr context) { releases++; return scenario != "release"; }
    public static string Test() {
        if (DshTokenPublicKey.PublicContextFlags != 0xF0000040) throw new System.Exception("unsafe flags");
        foreach (string scenario in new [] { "ok", "provider", "container", "auth", "no-key", "get-key", "export", "size", "destroy", "release" }) {
            var fake = new FakeTokenPublicKey(scenario);
            var result = DshTokenPublicKey.Read(fake, "fake-container");
            string expected = scenario == "ok" ? "public-keys" : scenario == "provider" ? "provider-unavailable"
                : scenario == "container" ? "container-unavailable" : "unknown";
            if (result.status != expected) throw new System.Exception("wrong outcome: " + scenario);
            bool acquired = scenario != "provider" && scenario != "container" && scenario != "auth";
            if (fake.releases != (acquired ? 1 : 0)) throw new System.Exception("context leak: " + scenario);
            bool hasKey = acquired && scenario != "no-key" && scenario != "get-key";
            if (fake.destroys != (hasKey ? 1 : 0)) throw new System.Exception("key leak: " + scenario);
            if (!acquired && fake.keys != 0) throw new System.Exception("read after failed acquire");
            if (scenario == "ok" && (fake.exports != 2 || fake.keys != 2)) throw new System.Exception("incomplete read");
            if (result.status != "public-keys" && result.publicKeys.Length != 0) throw new System.Exception("partial result escaped");
        }
        return "fake CSP cases passed";
    }
}
