# Repository Guidelines

## 项目结构与模块划分

Sider 是基于 Manifest V3 的 Chromium 扩展，使用原生 JavaScript 和 esbuild 构建。

- `src/background.js` 管理权限、标签页与侧栏；`src/panel.*` 实现扩展界面。
- `src/content/` 包含网页采集、AI 网站适配、附件、预设与悬浮球；共享设置和状态模块位于 `src/`。
- `tests/*.test.js` 为单元测试；`tests/browser/` 为浏览器测试及本地模拟页面。
- `assets/icons/` 存放图标；`scripts/` 提供构建、版本管理与开发工具；`demo/` 存放示例页面。
- `docs/` 包含使用、架构、验证与发布文档。`dist/`、`tmp/` 和扩展 ZIP 是忽略的生成产物，不提交到源码仓库。

## 构建、测试与开发命令

使用与 CI 一致的 Node.js 24，通过 `npm ci` 安装锁定版本的依赖。

- `npm run build`：校验版本一致性，将可加载的扩展构建到 `dist/`。
- `npm test`：运行全部 Node.js 单元测试。
- `npm run check`：运行单元测试与构建。
- `npm run dev`：启动安装说明和示例页面；完整扩展仍需在浏览器中加载 `dist/`。
- `npx playwright install chromium --no-shell`：安装测试浏览器。
- `npm run test:browser`：构建并运行全部隔离浏览器测试。
- `node scripts/test-browser.mjs launcher`：构建后单独运行悬浮球测试组。
- `npm run version:set -- X.Y.Z`：同步 package、锁文件和扩展清单版本；再用 `npm run version:check` 校验。

## 代码风格与命名约定

遵循相邻代码风格：两空格缩进、ES modules、单引号字符串和分号。文件名使用 `kebab-case`，函数与变量使用 `camelCase`，常量使用大写命名，扩展消息使用 `SIDER_*`。目前未配置独立的格式化或 lint 工具。网站差异放在适配层，共用发送逻辑保持可复用。

## 测试规范

使用 Node.js Test Runner、jsdom 与 Playwright。单元测试命名为 `*.test.js`，浏览器测试命名为 `tests/browser/<feature>.mjs`。修复缺陷时补充针对实际行为的回归测试；目前没有配置覆盖率百分比门槛。

浏览器测试使用独立配置和本地模拟页面，可通过 `SIDER_CHROMIUM` 指定已安装的 Chromium。保留用户草稿与附件，明确区分模拟测试结果和真实账号验证。详见[浏览器测试](docs/browser-tests.md)与[验证边界](docs/validation.md)。

## 提交与 Pull Request 规范

沿用历史中的简短祈使式提交标题，例如 `Fix ...`、`Add ...`、`Refactor ...`。每次提交聚焦一个主题，保留无关的工作区改动。PR 应说明问题、修改后的行为、关联 Issue 及已执行的检查；界面改动附截图，并注明尚未验证的场景。

## 安全与发布

不要将凭据或私人账号数据写入源码与日志，按需申请网站访问权限。更新版本并推送 GitHub 时，按[发布说明](docs/releasing.md)完成提交、推送与发布验证：`main` 上的版本文件变更会自动校验、测试、创建对应 `vX.Y.Z` 标签并发布 Release。已发布版本自动跳过；既有标签指向其他提交时停止，不移动或覆盖标签。确认 Release 和 ZIP 附件生成后再报告发布完成。
