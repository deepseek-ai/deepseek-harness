
## 发布前确认

核对以下信息后，点击 **Review deployments**，选择 <code>desktop-test</code> 并点击 **Approve and deploy**；信息有误请点击 **Reject**。

| 项目 | 发布信息 |
| --- | --- |
| 发布环境 | <code>test</code> |
| 版本号 | <code>1.0.0</code> |
| 升级通道 | <code>nightly</code> |
| 平台 | <code>win-x64</code> |
| 测试 release ID | <code>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</code><br>测试下载路径的随机前缀，用于降低地址被猜到的可能性；连续升级测试需使用相同值。 |
| 下载地址预览 | <a href="https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin/win-x64/deepseek-harness-1.0.0-win-x64.exe">https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin/win-x64/deepseek-harness-1.0.0-win-x64.exe</a><br>发布后的目标地址，审批前不保证可下载。 |
| 升级 YAML | <a href="https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/feeds/win-x64/nightly.yml">https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/feeds/win-x64/nightly.yml</a><br>本次发布将更新此文件；审批前可能不存在或仍指向旧版本。 |
| 打包来源 | <a href="https&#58;//github.com/owner/repo/actions/runs/10/attempts/2">查看打包运行 #10 · 第 2 次尝试</a><br>源码：<code>master @ bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</code><br>打包机器：<code>fixture-runner</code> |
| 签名与公证 | EXE 签名校验通过 |
| Git tag | 不创建（test 环境） |

### 批准后将执行

1. 重新校验产物与发布目标；若与审批摘要不一致则停止。
2. 上传缺少的文件，跳过内容一致的已有文件；发现内容冲突则停止。
3. 更新上述升级 YAML，并保存发布记录。

**本次只发布 test，不修改 production。**

<details>
<summary>技术详情与文件清单</summary>

COS 存储桶：<code>fixture-1250000000</code>

release ID 取自原打包产物清单。打包时优先使用表单 `test_release_id`；留空则使用机器 `presets/test.env` 中的 `DOWNLOAD_TEST_RELEASE_ID`。发布时不重新选择。

审批摘要 SHA-256：<code>cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc</code>

共 3 个文件；大小及 SHA-256 对应实际上传字节，包括更新后的 YAML 内容。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| <a href="https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin/win-x64/deepseek-harness-1.0.0-win-x64.exe">deepseek-harness-1.0.0-win-x64.exe</a> | 23 字节 | <code>7039e7b3e00d39fbfb2948ba31b6216ac9ffff01b4117a1cec08025255d9ad10</code> |
| <a href="https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin/win-x64/deepseek-harness-1.0.0-win-x64.exe.blockmap">deepseek-harness-1.0.0-win-x64.exe.blockmap</a> | 16 字节 | <code>4fd6c7d73e713d7f54f173dfc845d046d267f9e62c80a92670b0696131bfb74a</code> |
| <a href="https&#58;//example.com/dsh-desk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/feeds/win-x64/nightly.yml">nightly.yml</a> | 272 字节 | <code>faccf50f8398d6781568114dda9a678751e4c01044dd9424d00237c69e58cb59</code> |

</details>

若仓库为公开仓库，此摘要中的下载路径及 test 发布的 release ID 也会公开。随机前缀不能替代访问鉴权。
