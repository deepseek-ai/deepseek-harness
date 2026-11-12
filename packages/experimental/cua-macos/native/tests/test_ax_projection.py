"""Run the production AX projection on an isolated AppKit process's own windows."""
import subprocess
import tempfile
from pathlib import Path


def main():
    tests = Path(__file__).resolve().parent
    sources = sorted((tests.parent / "Sources" / "CuaNative").glob("*.swift"))
    with tempfile.TemporaryDirectory(prefix="ax-child-projection-") as temporary:
        executable = Path(temporary) / "probe"
        subprocess.run(["xcrun", "swiftc", "-swift-version", "6", "-parse-as-library",
                        *[str(source) for source in sources if source.name != "Main.swift"],
                        str(tests / "ChildProjectionFixture.swift"), "-o", str(executable)], check=True)
        subprocess.run([str(executable)], check=True, timeout=30)


if __name__ == "__main__":
    main()
