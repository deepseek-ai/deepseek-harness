"""Run Swift Testing with the selected Apple toolchain's runtime search paths."""
import subprocess
import sys
from pathlib import Path


def main():
    compiler = Path(subprocess.check_output(["xcrun", "--find", "swift"], text=True).strip())
    package = Path(__file__).resolve().parents[1]
    command = [str(compiler), "test", "--package-path", str(package),
               "--disable-xctest", "--enable-swift-testing"]
    # Command Line Tools ships these libraries outside SwiftPM's default search
    # paths. Full Xcode and other selected toolchains keep their normal lookup.
    framework_root = compiler.parents[2] / "Library/Developer/Frameworks"
    if (framework_root / "Testing.framework").is_dir():
        command += ["-Xswiftc", "-F", "-Xswiftc", str(framework_root),
                    "-Xlinker", "-F", "-Xlinker", str(framework_root),
                    "-Xlinker", "-rpath", "-Xlinker", str(framework_root)]
        runtime = framework_root.parent / "usr/lib"
        if (runtime / "lib_TestingInterop.dylib").is_file():
            command += ["-Xlinker", "-rpath", "-Xlinker", str(runtime)]
    command += sys.argv[1:]
    raise SystemExit(subprocess.call(command))


if __name__ == "__main__":
    main()
