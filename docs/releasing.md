# 版本与自动发布

推送 `vX.Y.Z` 标签后，GitHub Actions 会校验版本、运行单元测试和隔离浏览器回归，并将通过测试的 `dist/` 自动打包为 GitHub Release 附件。本地无需压缩或上传。

## 每次发布的操作步骤

当前版本为 **0.7.2**，包含划词“总是选中”和扩展重载后的重复悬浮球修复。以下以发布 **0.7.2** 为例；每次将命令中的版本号替换为新的版本号。命令在项目根目录的 PowerShell 中执行，不需要在本机安装 GitHub CLI。

### 1. 更新代码和版本

先保存并提交要发布的功能改动，再同步主分支，避免版本标签遗漏功能提交：

```powershell
Set-Location Q:\1Coding\Sider
git switch main
git pull --ff-only origin main
npm ci
npm run version:set -- 0.7.2
npm run version:check -- v0.7.2
npm run check
```

`version:set` 同步更新 `package.json`、`package-lock.json` 的两个版本字段与 `manifest.json`，不提交代码、不打标签。任一步骤报错时先停止并修复，检查全部成功后再继续。

`npm run check` 执行全量单元测试和构建；GitHub 发布流程还会运行全量隔离浏览器回归。需要先在本机验证浏览器时，可执行 `npm run test:browser`，浏览器安装与 `SIDER_CHROMIUM` 用法见 [浏览器回归](browser-tests.md)。

### 2. 提交并推送版本

```powershell
git diff --check
git diff
git add package.json package-lock.json manifest.json
git status --short
git commit -m "Release v0.7.2"
git push origin main
```

确认暂存区只包含本次准备发布的内容。如果上一步还有源码、测试或文档修改，需要先将相应文件一起提交；不要只发布版本号而遗漏功能代码。

### 3. 创建并推送发布标签

先确认本地和远端都没有使用过这个标签；如果已有同名标签，使用更高的新版本号：

```powershell
git tag --list v0.7.2
git ls-remote origin refs/tags/v0.7.2
```

两条命令均无输出表示该标签尚未使用，然后执行：

```powershell
git tag -a v0.7.2 -m "Sider v0.7.2"
git push origin v0.7.2
```

`git push origin main` 只推送代码；最后一条标签推送才触发 Release。只打本地标签不会发布，之后也不需要在 GitHub 再手工创建同名 Release。

### 4. 查看发布结果

到仓库的 [Actions → Release](https://github.com/ChinaYong/Sider/actions/workflows/release.yml) 查看进度。成功后，[Releases](https://github.com/ChinaYong/Sider/releases) 自动出现：

- `Sider-v0.7.2.zip`：可加载的扩展文件，`manifest.json` 直接位于 ZIP 根目录。
- `Sider-v0.7.2.zip.sha256`：ZIP 的 SHA-256 校验值。
- GitHub 自动生成的更新说明，可在 Release 页面继续编辑。

下载扩展附件并解压，再加载包含 `manifest.json` 的目录。GitHub 自动附带的 **Source code** 是源码归档，不能代替构建好的扩展 ZIP。

如需校验下载是否完整，在下载目录执行 `Get-FileHash .\Sider-v0.7.2.zip -Algorithm SHA256`，将结果与 `.sha256` 文件中的值比较。更新已有扩展时，解压到固定目录后在扩展管理页面点击“重新加载”，并重开旧侧栏。

## 版本号规则

本项目使用三段稳定版本号；每段为 0–65535 的整数，不含前导零，不能全为零。不使用 `-beta` 等后缀，以保持扩展清单版本可加载。通常问题修复递增最后一段，较大的功能或界面更新递增中间一段。

可单独检查文件一致性及标签：

```sh
npm run version:check
npm run version:check -- v0.7.2
```

普通构建也会检查版本一致性。版本不匹配时立即失败，避免发布标签与扩展内部显示的版本不同。

## 流程与权限

[`release.yml`](../.github/workflows/release.yml) 调用现有的 [`check.yml`](../.github/workflows/check.yml)，测试通过后保存构建产物，再由发布任务下载同一份产物、生成 ZIP 和校验值。测试失败会停止发布，浏览器失败证据保存在 Actions 的 `browser-evidence` 附件中。

普通分支推送和 Pull Request 继续执行检查；只有推送 `v*` 标签才执行发布。同一个标签的发布任务不会同时运行。重复发布已有 Release 会报错，不覆盖已经发布的文件。

使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需配置个人访问令牌。测试任务只有仓库读取权限；发布任务单独获得 `contents: write`，使用 GitHub CLI 创建 Release。仓库须启用 Actions，且仓库或组织策略允许此写入权限。实现参考 [GitHub 的可复用工作流说明](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)和 [GitHub CLI 的 Release 创建说明](https://cli.github.com/manual/gh_release_create)。

网络或运行器临时错误可在失败的 Actions 页面选择 **Re-run failed jobs**。如果失败操作已留下不完整的 Release 草稿，先在 GitHub 核对并移除该草稿再重跑。源码或版本号需要修复时，提交修复后使用新的版本标签，不移动已经发布的标签。

GitHub Actions 首次成功运行并产出 Release，才代表云端发布链路验证完成；本地测试和构建不等于已上线发布。
