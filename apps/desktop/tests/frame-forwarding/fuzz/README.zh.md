# 帧转发线路协议的模糊测试目标

[English](README.md) | 中文

这些 libFuzzer 测试覆盖 `packages/experimental/frame-forwarding/native` 中的原生解析代码。它们把任意字节交给两类解析器：一类解析 producer 进程发给 receiver 的数据，另一类是 producer 解析从 receiver 收到的数据。Windows 和 macOS 上都启用 AddressSanitizer，macOS 上另外启用 UndefinedBehaviorSanitizer，因为 MSVC 不支持 UBSan。这些目标只在手动启动时运行，任何测试套件和 CI 任务都不会运行它们。

测试把生产代码的 `transport.cc` 编译进自己的翻译单元，因而不必从 addon 导出，就能调用其文件内的 `decode_packet` 和 `encode_header`。脚本编译的是源码快照，例如 `git archive HEAD` 的输出，因此工作区里正在进行的修改不会影响运行结果。

## 测试目标

| 源文件 | 入口 | 检查 |
| --- | --- | --- |
| `packet-fuzzer.cc` | `decode_packet`，分别按 Windows 管道消息（`padded=false`）和 macOS Mach 消息（`padded=true`）解析 | 被接受的包用 `encode_header` 重新编码后，再解码得到相同的字段、token 和文本；文本在容量内以 NUL 结尾，除非正好占满容量；两种约定都接受同一输入时，结果一致。 |
| `endpoint-fuzzer.cc` | `parse_endpoint`、`parse_connection`，以及 `Channel::send` 写入的标识符 | 被接受的 endpoint 符合协议，并能从其 `1\|<pid>\|<token>\|<name>` 形式解析回来；被接受的连接标识符不超过 2^53-1，并能从其十进制形式解析回来。 |

检查失败时会打印十六进制的输入并中止，libFuzzer 会把这个输入保存为崩溃样本。

## 种子语料

`corpus/` 中每种包各有一个合法样本，由 `corpus-gen.cc` 用生产代码的 `encode_header` 生成。运行脚本还会加入仓库里不保存的种子：协议 1 的 hello、在包头之前就结束的当前版本 hello、文本占满容量且没有终止符的消息，以及文本长度不是 4 的倍数的每个种子的 Mach 填充形式。

## 在 Windows 上运行

工具链来自安装了 C++ AddressSanitizer 组件的 Visual Studio 2022。在仓库根目录运行：

```powershell
$root = Join-Path $env:TEMP 'dsh-frame-forwarding-fuzz'
New-Item -ItemType Directory -Force "$root\src" | Out-Null
git archive --output "$root\src.tar" HEAD packages/experimental/frame-forwarding/native
tar -x -f "$root\src.tar" -C "$root\src"
apps/desktop/tests/frame-forwarding/fuzz/run-windows.ps1 -NativeDir "$root\src\packages\experimental\frame-forwarding\native" -MaxTotalTime 600
```

脚本会找到 `vcvarsall.bat`，用 `/fsanitize=address /fsanitize=fuzzer` 编译（MSVC 不接受逗号分隔的写法），把包含 `clang_rt.asan_dynamic-x86_64.dll` 的目录加入 `PATH`，并以 `-timeout=10 -rss_limit_mb=2048` 运行每个目标。`-Build` 或 `-Run` 只执行其中一步。二进制文件、生成的语料、日志和崩溃样本都放在 `%TEMP%\dsh-frame-forwarding-fuzz\work` 下。

## 在 macOS 上运行

Apple clang 不带 libFuzzer，因此脚本使用 Homebrew LLVM。在仓库根目录运行：

```bash
d=$(mktemp -d /tmp/dsh-frame-forwarding-fuzz.XXXXXX)
git archive HEAD packages/experimental/frame-forwarding/native | tar -x -C "$d"
CXX=/opt/homebrew/opt/llvm/bin/clang++ bash apps/desktop/tests/frame-forwarding/fuzz/run-macos.sh \
  --native "$d/packages/experimental/frame-forwarding/native" --work "$d/work" --max-total-time 600
```

脚本用 `-fsanitize=fuzzer,address,undefined -fno-sanitize-recover=undefined` 编译，并链接 `IOSurface`、`CoreFoundation` 和 `libbsm`。

## 查看运行结果

每次运行都以一行 `DONE` 和 `-print_final_stats=1` 的统计结束。MSVC 构建只报告特征数（`ft:`），clang 构建还报告覆盖的边数（`cov:`）。导致崩溃、超时或内存耗尽的输入会以 `crash-*`、`timeout-*` 或 `oom-*` 的名字写入 `<work>/artifacts-<target>/`。用下面的命令把它最小化：

```
<work>/<target>-fuzzer -minimize_crash=1 -timeout=10 -rss_limit_mb=2048 <work>/artifacts-<target>/crash-<hash>
```
