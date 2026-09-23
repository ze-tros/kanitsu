# GitHub Actions 持续集成指南

本文档说明 Kanitsu 仓库的 GitHub Actions 工作流：各自负责什么、如何触发、失败如何排查，以及首次接入时需要在 GitHub 侧完成的设置。Windows 版本准备、产物验收和 GitHub Release 流程仍以 [Windows Portable 打包与发布指南](Windows-Portable-打包与发布指南.md) 为准，本文不重复。

## 1. 工作流总览

| 工作流 | 文件 | 触发 | Runner | 作用 | 产物 |
|---|---|---|---|---|---|
| `CI` | `.github/workflows/ci.yml` | 推送到 `master`、任意 pull request、手动 | `ubuntu-latest` | 合并前质量门禁 | 无 |
| `Android Debug APK` | `.github/workflows/android-debug.yml` | 手动、推送 `v*` tag | `ubuntu-latest` | 构建 Android 调试 APK | `Kanitsu-Android-Debug`（`app-debug.apk`，保留 14 天） |
| `Windows Portable` | `.github/workflows/windows-portable.yml` | 手动、推送 `v*` tag | `windows-latest` | 打包并校验 Windows x64 Portable | `Kanitsu-Portable-<version>-x64`（EXE + `SHA256SUMS.txt`，保留 14 天）；tag 上由 `release` 作业自动创建 draft Release |

三个工作流的默认权限是 `contents: read`；只有 `Windows Portable` 的 `release` 作业申请 `contents: write`，用于在 tag 上创建 draft Release（`build` 作业本身仍是只读）。同一 ref 上有新的运行启动时，旧的未完成运行会被取消（`concurrency.cancel-in-progress`）。

`CI` 只监听 `master` 推送和 pull request，不监听其他分支的推送。需要让长期分支也常驻检查时，在 `ci.yml` 的 `push.branches` 中补上分支名即可。

三个工作流引用的 action 都按 commit SHA 固定，并选用声明 `node24` 运行时的大版本（2026-09 由 v4 升级：checkout v7.0.1、setup-node v7.0.0、setup-java v6.0.1、cache v6.1.0、upload-artifact v7.0.1），避免 GitHub 的 Node 20 运行时弃用。升级大版本前先用 GitHub API 解析确认 SHA 是真实 commit，并核对用到的输入在新版本中仍然存在。`CI` 不产出 artifact —— 它是合并门禁；可下载产物由 `Android Debug APK` 和 `Windows Portable` 提供。

## 2. CI 门禁内容

`CI` 工作流的步骤与本地命令一一对应：

| CI 步骤 | 本地等价命令 |
|---|---|
| 安装依赖 | `npm ci --strict-allow-scripts` |
| 类型检查 | `npm run typecheck` |
| 工作区测试 | `npm test --workspaces --if-present` |
| Web 生产构建 | `npm run build:web` |
| Electron 主进程编译 | `npm run build:desktop` |

在提交前跑一遍上述命令即可复现 CI 结果；`npm run typecheck && npm test --workspaces --if-present` 是最常用的快速组合。

`CI` 运行在 `ubuntu-latest`：类型检查、工作区测试（`packages/{core,fs-adapter,ui,raw-decoder}`）和 Vite 构建都是平台无关的纯逻辑，Linux 上更快也更省额度。Windows 专有的打包与资源编辑留在 `windows-portable.yml` 中，由 `windows-latest` 负责，两者互补而不重复。

由此带来一条约束：**新增测试不能依赖 Windows 路径或盘符**。跨平台路径处理请走 `packages/core/src/path.ts` 的归一化逻辑，已有测试 `imageIdFor normalizes path separators` 就是这条约束的守卫。

## 3. Android 调试包

用于在真实设备上安装体验，不需要本地 JDK 和 Android SDK：

1. 打开仓库的 `Actions`。
2. 左侧选择 `Android Debug APK`。
3. `Run workflow` 选择分支或 ref；也可以推送 `v*` tag 自动触发。
4. 运行完成后在该次运行的 `Artifacts` 中下载 `Kanitsu-Android-Debug`（内含 `app-debug.apk`）。

工作流执行的是 `npm run build:android`：构建 Web 生产包、`cap sync` 同步 Capacitor、由 Gradle wrapper 执行 `assembleDebug`。环境使用 JDK 17（AGP 8.2.1 的要求），Android SDK 由 GitHub 的 `ubuntu-latest` 镜像预装，Gradle 缓存按 `apps/mobile/android` 下的构建脚本哈希做键值复用。

两个需要知道的细节：

- Gradle wrapper 的发行源和 Maven 仓库配置在仓库内，指向国内镜像（`mirrors.cloud.tencent.com`、`maven.aliyun.com`），Maven 侧保留 `google()` 与 `mavenCentral()` 回退。Maven 依赖失败时，Gradle 会自动回退到官方源；wrapper 发行包没有回退，但 2026-09-22 实测从 GitHub runner 直接下载成功（gradle 8.5 发行包），无需改动。将来若镜像不可达，再把 `gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl` 改成官方 `services.gradle.org`。
- `gradlew` 在 git 中必须是可执行文件（`100755`）。历史上曾以 `100644` 提交，会在 Linux runner 上报 `Permission denied`。工作流中保留了 `chmod +x` 兜底，但根本修法是用 `git update-index --chmod=+x apps/mobile/android/gradlew` 修正文件模式。

Android 工作流当前不在 pull request 上运行，因此不参与合并门禁；需要在 PR 上验证移动端改动时，给 `android-debug.yml` 增加带路径过滤的 `pull_request` 触发即可。

## 4. Windows Portable

打包流程、版本号规则、产物校验和 Release 创建见 [Windows Portable 打包与发布指南](Windows-Portable-打包与发布指南.md)。该工作流已包含类型检查与工作区测试，因此在 tag 发布路径上仍有 Windows 侧验证。

## 5. 首次接入：GitHub 侧要做的事

- [ ] 把 `.github/workflows/` 下的工作流推送到 `master`（`workflow_dispatch` 手动触发要求工作流文件已存在于默认分支）。
- [ ] 确认 `Settings` → `Actions` → `General` 允许运行工作流（仓库默认允许；若曾被禁用需在此开启）。
- [ ] 打开 `Actions` 确认 `CI` 在推送后自动运行并通过。
- [x] 手动触发一次 `Android Debug APK`（2026-09-22 实测通过：Gradle 镜像可达，APK 产物可下载）。
- [ ] 可选：在 `Settings` → `Branches` 的分支保护规则中把 `Typecheck, Tests and Web Build` 设为必需检查项（名称来自 `ci.yml` 中 job 的 `name`）。
- [ ] 可选：确认 `Settings` → `Actions` → `General` 的 `Workflow permissions` 为只读即可，工作流不需要写权限。

## 6. 失败排查

**依赖安装脚本未审核** — `npm ci --strict-allow-scripts` 报告某个包不在 `allowScripts` 中。按 Portable 指南第 12 节处理：确认来源后执行 `npm approve-scripts <package>`，提交精确版本的许可，不要用 `--dangerously-allow-all-scripts` 绕过。

**类型检查或测试失败** — 在本地用第 2 节的等价命令复现。CI 日志中失败步骤的名称与表格中的步骤名一致。

**仅在 CI 上失败的测试** — 多半是平台依赖：绝对路径、盘符、Windows 换行或大小写不敏感的文件名。把平台差异收敛到适配层，不要在测试里写死分隔符。

**Android 构建失败** — 先看失败发生在依赖解析还是执行阶段。`distributionUrl` 下载失败属于镜像可达性问题，处理方式见第 3 节；Gradle 缓存命中损坏时可重新运行一次，或临时提高日志级别。

**`npm ci` 耗时过长** — `@kanitsu/desktop` 依赖的 Electron 会在安装时下载对应平台的预编译包。如成为常态，可给 `CI` 加一步缓存 `~/.cache/electron`。

## 7. 后续可选扩展

- 在 pull request 上按路径触发 Android 构建（`apps/mobile/**`、`apps/web/**`、`packages/**`）。
- 让 `release` 作业直接发布 Release（去掉 `--draft`）——目前保留人工验收关口，因为产物还没有代码签名。
- 把 Web 演示模式部署到 GitHub Pages（需在仓库设置中把 Pages 的 Source 改为 GitHub Actions）。
- 接入 Windows 代码签名密钥，见 Portable 指南第 14 节。
