
## 发布前确认

核对以下信息后，点击 **Review deployments**，选择 <code>desktop-production</code> 并点击 **Approve and deploy**；信息有误请点击 **Reject**。

| 项目 | 发布信息 |
| --- | --- |
| 发布环境 | <code>production</code> |
| 版本号 | <code>1.0.0</code> |
| 升级通道 | <code>latest</code> |
| 平台 | <code>win-x64</code> |
| 下载地址预览 | <a href="https&#58;//download.example.com/dsh-desk/bin/win-x64/latest/deepseek-harness-1.0.0-win-x64.exe">https&#58;//download.example.com/dsh-desk/bin/win-x64/latest/deepseek-harness-1.0.0-win-x64.exe</a><br>发布后的目标地址，审批前不保证可下载。 |
| 升级 YAML | <a href="https&#58;//download.example.com/dsh-desk/feeds/win-x64/latest.yml">https&#58;//download.example.com/dsh-desk/feeds/win-x64/latest.yml</a><br>本次发布将更新此文件；审批前可能不存在或仍指向旧版本。 |
| 打包来源 | <a href="https&#58;//github.com/owner/repo/actions/runs/20/attempts/3">查看打包运行 #20 · 第 3 次尝试</a><br>源码：<code>dsh-v1.0.0 @ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</code><br>打包机器：<code>windows-publisher</code> |
| 签名与公证 | EXE 签名校验通过 |
| Git tag | <code>desktop-v1.0.0</code> |

### 批准后将执行

1. 重新校验产物与发布目标；若与审批摘要不一致则停止。
2. 上传缺少的文件，跳过内容一致的已有文件；发现内容冲突则停止。
3. 更新上述升级 YAML，并保存发布记录。
4. 为实际打包提交创建上述 Git tag；若 tag 创建失败，记录“已发布，待补 tag”。

<details>
<summary>技术详情与文件清单</summary>

COS 存储桶：<code>production-1234567890</code>

审批摘要 SHA-256：<code>cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc</code>

共 2 个文件；大小及 SHA-256 对应实际上传字节，包括更新后的 YAML 内容。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| <a href="https&#58;//download.example.com/dsh-desk/bin/win-x64/latest/deepseek-harness-1.0.0-win-x64.exe">deepseek-harness-1.0.0-win-x64.exe</a> | 15 字节 | <code>e34210a6de4f653edf588301431c3d69a633638cbf587345cc50a7fed9f38f4c</code> |
| <a href="https&#58;//download.example.com/dsh-desk/feeds/win-x64/latest.yml">latest.yml</a> | 15 字节 | <code>8850e6075dda0080c526269a4de29848c32c2a65e3d81f4a64ed8ce53d4b47c1</code> |

</details>

若仓库为公开仓库，此摘要中的下载路径及 test 发布的 release ID 也会公开。随机前缀不能替代访问鉴权。
