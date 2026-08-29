# Windows Portable 打包与发布指南

本文档说明如何为Kanitsu（Kanitsu）准备版本、执行本地预检、触发 Windows Portable CI、校验产物并发布 GitHub Release。

## 1. 发布产物与当前边界

当前 Windows 目标是 x64 Portable 单 EXE，产物名称固定为：

```text
Kanitsu-Portable-<version>-x64.exe
SHA256SUMS.txt
```

Portable 在这里表示“单 EXE、免安装”，不表示“数据随 EXE 携带”。图包库、缩略图缓存和日志仍写入 Electron `userData` 目录。

当前还没有 Windows 代码签名证书和自定义 `.ico` 图标，因此：

- EXE 的 Authenticode 状态为 `NotSigned`。
- Windows SmartScreen 可能显示风险提示。
- 在签名和图标完成前，更适合称为“可分发的 Portable 构建”，不应宣称已通过 Windows 信任验证。

## 2. 流水线结构

完整发布链路为：

```text
更新版本 -> 本地预检 -> 提交/合并 -> 创建 tag -> CI 构建
-> 下载 Artifact -> 校验与验收 -> 创建 Release -> 发布后复核
```

GitHub Actions 工作流位于：

```text
.github/workflows/windows-portable.yml
```

工作流使用 `windows-latest` 和 Node.js 24，执行顺序如下：

1. 从官方 GitHub 发布源准备 Electron 和 electron-builder 二进制。
2. 执行 `npm ci --strict-allow-scripts`，未审核的依赖安装脚本会直接使构建失败。
3. 运行全工作区 TypeScript 检查。
4. 运行所有已配置的 workspace 测试。
5. 构建 Web 生产包和 Electron 主进程、preload 代码。
6. 使用唯一 staging 目录构建 Windows x64 Portable EXE。
7. 校验文件名、文件体积、DOS/PE/COFF 结构和 SHA-256。
8. 再次以只读方式核对 `SHA256SUMS.txt`。
9. 上传 EXE 和校验文件为 Actions Artifact，保留 14 天。

同一 ref 上有新构建启动时，旧的未完成构建会被取消。

打包脚本当前对 electron-builder 设置 `npmRebuild=false`。这是为了避免 npm workspace 下的依赖重建破坏提升后的根依赖树；现有 `sharp` 使用 Node-API 预构建二进制。以后引入需要 Electron ABI 重编译的原生模块时，必须重新评估这个设置，不能假设新原生模块会自动可用。

## 3. 发布前置条件

发布操作者需要：

- 具有仓库推送 tag 和创建 GitHub Release 的权限。
- 确认仓库已启用 GitHub Actions。
- 确认 `windows-portable.yml` 已存在于 GitHub 默认分支。
- 本地预检时使用 Windows x64、Node.js 24 和 npm。
- 确认所有计划发布的代码已合并，工作区不包含未提交变更。

检查本地状态：

```powershell
git status --short
git log -1 --oneline
```

`git status --short` 在发布前应没有输出。

## 4. 准备版本号

版本号使用 SemVer，例如 `0.2.0`。Windows 发布版本由两个文件共同维护：

```text
package.json
apps/desktop/package.json
```

两处 `version` 必须完全一致。可使用 npm 更新：

```powershell
$version = '0.2.0'
npm pkg set "version=$version"
npm pkg set "version=$version" -w @kanitsu/desktop
npm install --package-lock-only
```

然后核对版本：

```powershell
npm pkg get version
npm pkg get version -w @kanitsu/desktop
git diff -- package.json apps/desktop/package.json package-lock.json
```

版本变更应先提交并合并到计划发布的分支，再创建 tag。不要在未合并的临时工作区上制作正式发布。

## 5. 本地发布预检

首次检查或 lockfile 变更后，使用干净安装：

```powershell
npm ci
```

执行完整本地发布链路：

```powershell
npm run release:portable
```

该命令依次执行：

```text
typecheck -> workspace tests -> web build -> desktop build -> portable build -> verification
```

成功后本地产物位于：

```text
apps/desktop/release/portable/Kanitsu-Portable-<version>-x64.exe
apps/desktop/release/portable/SHA256SUMS.txt
```

重新核对现有产物：

```powershell
npm run verify:portable
```

此命令不会重写已有的 `SHA256SUMS.txt`；如果 EXE 或校验文件被替换，命令应失败。

本地默认关闭 Electron Builder 的 EXE 资源编辑，以避免普通 Windows 环境中 `winCodeSign` 符号链接解压失败。开启 Windows 开发者模式后，可用与 CI 更接近的方式打包：

```powershell
$env:KANITSU_SIGN_AND_EDIT_EXECUTABLE = 'true'
npm run release:portable
Remove-Item Env:KANITSU_SIGN_AND_EDIT_EXECUTABLE
```

由于打包时间戳和资源编辑设置可能不同，本地 EXE 与 CI EXE 的 SHA-256 不必相同。对外发布时以 CI 产物为准。

## 6. 手动触发 CI

手动触发适合预发布验证、补包和不创建 tag 的分支构建。

### 6.1 GitHub 网页操作

1. 打开 GitHub 仓库。
2. 进入 `Actions`。
3. 在左侧选择 `Windows Portable`。
4. 点击右侧的 `Run workflow`。
5. 选择要构建的分支或 ref。
6. 再次点击 `Run workflow` 确认。
7. 进入新的 workflow run，等待 `Build Windows x64 Portable` 任务完成。

如果界面没有 `Run workflow`，检查：

- 工作流文件是否已推送到默认分支。
- 仓库的 Actions 是否启用。
- 当前账号是否有运行 workflow 的权限。

### 6.2 GitHub CLI 操作

已安装并登录 `gh` 时，可执行：

```powershell
gh workflow run windows-portable.yml --ref master
gh run list --workflow windows-portable.yml --limit 5
```

`master` 仅为示例，应替换为实际需要构建的分支。获得 run ID 后可等待完成：

```powershell
gh run watch <run-id> --exit-status
```

## 7. 通过 tag 触发正式构建

工作流监听所有 `v*` tag。tag 必须严格等于 `v` 加桌面版本，例如：

```text
desktop version: 0.2.0
required tag:    v0.2.0
```

推荐流程：

先确认版本 commit 已合并并出现在远端。如果仓库使用受保护分支，通过 pull request 合并；允许直接推送时，可先执行 `git push origin <branch>`。然后在要发布的 commit 上创建 tag：

```powershell
$tag = 'v0.2.0'
git status --short
git log -1 --oneline
git tag -a $tag -m "release: $tag"
git push origin $tag
```

创建 tag 前应确认目标 commit 已推送至远端。可在 GitHub 的 `Actions` -> `Windows Portable` 中查看自动触发的运行。

注意：

- 不要把已公开发布的 tag 移动到新 commit。
- 版本或 tag 写错时，优先创建新的补丁版本，不要覆盖已发布产物。
- tag 不匹配时，构建脚本会在编译前失败。

## 8. 下载和校验 CI 产物

### 8.1 从 GitHub 网页下载

1. 打开成功的 workflow run。
2. 找到页面底部的 `Artifacts`。
3. 下载 `Kanitsu-Portable-<version>-x64`。
4. 将 Artifact ZIP 解压到新的空目录。

Actions Artifact 总是带 ZIP 外包装；ZIP 内部的应用仍是 Portable 单 EXE。

### 8.2 使用 GitHub CLI 下载

```powershell
gh run download <run-id> --name Kanitsu-Portable-0.2.0-x64 --dir .\release-download
```

### 8.3 校验 SHA-256

在解压后的目录中执行：

```powershell
$exe = '.\Kanitsu-Portable-0.2.0-x64.exe'
$checksumLine = Get-Content -Raw '.\SHA256SUMS.txt'
$expected = ($checksumLine -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()

if ($actual -ne $expected) {
  throw "SHA-256 mismatch: expected $expected, actual $actual"
}

Write-Host "SHA-256 verified: $actual"
```

哈希不匹配时不得发布或运行该 EXE。应重新下载 Artifact；如果仍不匹配，应保留 workflow run 和下载文件供排查。

`SHA256SUMS.txt` 与 EXE 来自同一次 CI，可用于发现下载损坏或非预期替换，但不能单独证明发布者身份。发布者身份与文件信任最终需要 Authenticode 代码签名。

### 8.4 检查签名状态

```powershell
Get-AuthenticodeSignature -LiteralPath .\Kanitsu-Portable-0.2.0-x64.exe |
  Select-Object Status, StatusMessage, SignerCertificate
```

当前版本预期为 `NotSigned`。未签名是已知限制，不应被当作校验失败；但在宣称已签名的版本中，任何非 `Valid` 状态都必须阻止发布。

## 9. 发布前验收

建议在干净的 Windows 10/11 x64 环境中验收 CI 产物，至少覆盖：

- EXE 可直接启动，主窗口标题正确，Windows 文件属性中的产品名和版本正确。
- 首次启动和第二次启动均正常。
- 导入包含中文路径、空格和常用图片格式的测试目录。
- 图包列表、封面加载、滚动停止、搜索、排序和目录导航正常。
- 打开原图，验证缩放、平移、旋转和上下张导航。
- 执行整理预览、整理和撤销。
- 导出 ZIP，检查目录结构和 `index.json`。
- 关闭并重新启动，确认图包索引和缩略图缓存可继续使用。
- 确认 SmartScreen 提示与本次发布的签名状态一致。

验收过程会写入当前 Windows 用户的 Electron `userData`。使用专用测试账号或虚拟机可避免污染日常数据。

## 10. 创建 GitHub Release

当前工作流只生成 Actions Artifact，不会自动创建 GitHub Release。验收通过后才应发布。

### 10.1 GitHub 网页操作

1. 进入仓库的 `Releases`。
2. 选择 `Draft a new release`。
3. 选择已触发成功构建的 tag，例如 `v0.2.0`。
4. 标题建议使用 `Kanitsu v0.2.0`。
5. 记录新功能、修复、已知问题和数据兼容性说明。
6. 上传从该 tag 的 CI Artifact 中解压得到的 EXE 和 `SHA256SUMS.txt`。
7. 再次检查文件名、版本号和 SHA-256。
8. 预发布版本勾选 `Set as a pre-release`；稳定版本再设为 latest release。
9. 点击 `Publish release`。

不要把 Actions 下载的整个 ZIP 作为唯一附件。Release 中应直接提供 EXE 和校验文件，方便用户下载单文件应用。

### 10.2 GitHub CLI 操作

```powershell
$tag = 'v0.2.0'
$exe = '.\release-download\Kanitsu-Portable-0.2.0-x64.exe'
$sum = '.\release-download\SHA256SUMS.txt'

gh release create $tag $exe $sum `
  --title "Kanitsu $tag" `
  --generate-notes `
  --draft
```

先创建 draft，在 GitHub 网页完成最后复核后再发布。

## 11. 发布后检查

发布完成后：

1. 从 GitHub Release 页面重新下载 EXE 和 `SHA256SUMS.txt`，不使用发布者本地副本。
2. 按第 8 节再次校验 SHA-256。
3. 确认 Release 标题、tag、产物版本和文件名一致。
4. 确认用户不需要安装程序，可直接运行 Portable EXE。
5. 保留该次 workflow run 链接、提交 SHA 和验收结果。

## 12. 失败处理

### 版本或 tag 不匹配

现象：构建在编译前报告 tag 与 desktop version 不一致。

处理：核对根 `package.json`、`apps/desktop/package.json` 和 tag。对已公开的 tag 使用新的补丁版本，不覆盖原 tag。

### 依赖安装脚本未审核

现象：`npm ci --strict-allow-scripts` 报告某个包不在 `allowScripts` 中。

处理：

1. 检查包的来源、版本和安装脚本内容。
2. 确认必须后，执行 `npm approve-scripts <package>`。
3. 检查 `package.json` 中新增的精确版本许可。
4. 提交变更后重新运行 CI。

不要使用 `--dangerously-allow-all-scripts` 绕过正式发布检查。

### Electron 或 electron-builder 下载失败

正式 CI 应使用官方 GitHub 发布源。可先重试失败任务并检查 GitHub 服务状态，不要为了临时通过而把正式 CI 改为第三方镜像。

本地需要镜像时，可临时设置：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm ci
npm run release:portable
Remove-Item Env:ELECTRON_MIRROR
Remove-Item Env:ELECTRON_BUILDER_BINARIES_MIRROR
```

使用镜像得到的本地产物不作为正式发布产物。

### `winCodeSign` 符号链接解压失败

本地保持 `KANITSU_SIGN_AND_EDIT_EXECUTABLE=false`（默认）即可绕过资源编辑。如需启用，开启 Windows 开发者模式或使用拥有符号链接权限的环境。

### 旧产物或 `app.asar` 被占用

构建已使用每次唯一的 staging 目录。如果替换最终产物时仍失败，关闭正在运行的 Portable EXE，确认没有残留的Kanitsu进程，然后重试。

### SHA-256 不匹配

不要手工重写 `SHA256SUMS.txt`或继续发布。重新下载 CI Artifact；如果仍失败，重新运行该 commit/tag 的构建并保留失败证据。

## 13. 回滚和紧急处理

已发布版本发现严重问题时：

1. 在 GitHub Release 中标记问题，必要时将 Release 转为 draft 或移除有问题的附件。
2. 不覆盖原 tag，保留原始 commit 和构建记录。
3. 在新 commit 中修复问题并升级补丁版本，例如从 `0.2.0` 升级到 `0.2.1`。
4. 从版本准备开始重走全部流程。
5. 在新 Release 说明受影响版本、修复内容和用户处理建议。

当前应用没有自动更新链路，所以回滚的核心是停止分发问题产物并发布新补丁版，而不是覆盖旧文件。

## 14. 后续接入代码签名

取得 Windows 代码签名证书后，建议：

1. 使用 GitHub Environment 保护正式发布密钥，并要求人工审批。
2. 仅允许可信 `v*` tag 的构建使用 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD`。
3. 不在 pull request 或任意分支构建中暴露签名密钥。
4. 签名完成后再生成 SHA-256。
5. 在 CI 中增加 `Get-AuthenticodeSignature` 检查，非 `Valid` 状态必须失败。
6. 用新的已签名产物重跑干净 Windows 验收。

签名接入是独立的发布安全变更，应单独评审和测试，不与普通功能发布混在同一次变更中。

## 15. 发布检查清单

可在每次发布时按以下顺序核对：

- [ ] 根包与 desktop 版本一致。
- [ ] 版本变更和 lockfile 已提交。
- [ ] 本地 `npm run release:portable` 通过。
- [ ] 目标 commit 已推送至远端。
- [ ] `v<version>` tag 指向正确 commit。
- [ ] `Windows Portable` workflow 成功。
- [ ] 已下载并解压 CI Artifact。
- [ ] SHA-256 校验通过。
- [ ] 签名状态与发布预期一致。
- [ ] 干净 Windows x64 环境验收通过。
- [ ] GitHub Release 使用对应 tag。
- [ ] Release 直接附加 EXE 和 `SHA256SUMS.txt`。
- [ ] 发布后重新下载并复核。
