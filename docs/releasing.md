# 版本与自动发布

推送 `vX.Y.Z` 标签后，GitHub Actions 会校验版本、运行单元测试和隔离浏览器回归，并将通过测试的 `dist/` 自动打包为 GitHub Release 附件。本地无需压缩或上传。

## 发布一次版本

本次版本为 **0.7.0**。先把本次功能改动、版本文件和 `.github/workflows/` 中的发布流程一起提交并推送，再给该提交打标签：

```sh
git tag -a v0.7.0 -m "Sider v0.7.0"
git push origin v0.7.0
```

到仓库的 [Actions → Release](https://github.com/ChinaYong/Sider/actions/workflows/release.yml) 查看进度。成功后，[Releases](https://github.com/ChinaYong/Sider/releases) 自动出现：

- `Sider-v0.7.0.zip`：可加载的扩展文件，`manifest.json` 直接位于 ZIP 根目录。
- `Sider-v0.7.0.zip.sha256`：ZIP 的 SHA-256 校验值。
- GitHub 自动生成的更新说明，可在 Release 页面继续编辑。

下载扩展附件并解压，再加载包含 `manifest.json` 的目录。GitHub 自动附带的 **Source code** 是源码归档，不能代替构建好的扩展 ZIP。

## 下次更新版本

用一个命令同步 `package.json`、`package-lock.json` 的两个版本字段与 `manifest.json`：

```sh
npm run version:set -- 0.7.1
npm run check
```

检查并提交本次改动，推送代码，然后创建并推送对应的 `v0.7.1` 标签。`version:set` 只更新文件，不会自动提交、打标签或推送。

本项目使用三段稳定版本号；每段为 0–65535 的整数，不含前导零，不能全为零。不使用 `-beta` 等后缀，以保持扩展清单版本可加载。通常问题修复递增最后一段，较大的功能或界面更新递增中间一段。

可单独检查文件一致性及标签：

```sh
npm run version:check
npm run version:check -- v0.7.0
```

普通构建也会检查版本一致性。版本不匹配时立即失败，避免发布标签与扩展内部显示的版本不同。

## 流程与权限

[`release.yml`](../.github/workflows/release.yml) 调用现有的 [`check.yml`](../.github/workflows/check.yml)，测试通过后保存构建产物，再由发布任务下载同一份产物、生成 ZIP 和校验值。测试失败会停止发布，浏览器失败证据保存在 Actions 的 `browser-evidence` 附件中。

普通分支推送和 Pull Request 继续执行检查；只有推送 `v*` 标签才执行发布。同一个标签的发布任务不会同时运行。重复发布已有 Release 会报错，不覆盖已经发布的文件。

使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需配置个人访问令牌。测试任务只有仓库读取权限；发布任务单独获得 `contents: write`，使用 GitHub CLI 创建 Release。仓库须启用 Actions，且仓库或组织策略允许此写入权限。实现参考 [GitHub 的可复用工作流说明](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)和 [GitHub CLI 的 Release 创建说明](https://cli.github.com/manual/gh_release_create)。

网络或运行器临时错误可在失败的 Actions 页面选择 **Re-run failed jobs**。如果失败操作已留下不完整的 Release 草稿，先在 GitHub 核对并移除该草稿再重跑。源码或版本号需要修复时，提交修复后使用新的版本标签，不移动已经发布的标签。

GitHub Actions 首次成功运行并产出 Release，才代表云端发布链路验证完成；本地测试和构建不等于已上线发布。
