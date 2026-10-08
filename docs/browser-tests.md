# 浏览器回归

测试使用 Playwright、独立浏览器配置及本地 HTTP/HTTPS 页面，加载当前 `dist`。测试域名在该进程内映射到回环地址，不使用登录账号，也不向真实 AI 服务发送消息。

```sh
npm ci
npx playwright install chromium --no-shell
npm run test:browser
```

Linux CI 安装系统依赖可用 `npx playwright install --with-deps chromium --no-shell`。脚本使用完整 Chromium 通道，以支持扩展；不使用无头 shell。浏览器缺失时，失败信息会给出安装命令。

可以设置 `SIDER_CHROMIUM` 指定支持扩展调试的 Chromium 可执行文件。它仍使用新建的隔离配置，不能指向用户的浏览器配置目录。也可设置 `PLAYWRIGHT_BROWSERS_PATH` 指定下载位置；安装和运行时必须使用同一值。

单独运行某组用例时，先构建，再使用：

```sh
npm run build
node scripts/test-browser.mjs fresh-send
```

| 测试组 | 验证范围 |
| --- | --- |
| `permissions` | 生产权限清单、原生 action 的 activeTab、未授权和跨站导航后的访问拒绝 |
| `context` | 标签页隔离、Enter／按钮一次发送及自动取消预设勾选、Shift+Enter／真实 IME、不带桥接参数的导航、重新加载后保留取消状态、窄屏 |
| `fresh-send` | 长正文尾部、闲置采集计数、发送前采集一次、慢上传、重复发送、失败、草稿修改、来源变化、用户文件保护，以及正文复制／下载、预设和配置备份 |
| `entry-drop` | MAIN／ISOLATED 协作、FileList／文件条目读取、迟到附件、取消和动态网站脚本 |
| `gemini-upload` | 明确关闭拖放兼容探测后验证菜单路线、多隐藏输入、动态文件输入、控件替换、失败／超时／取消，以及空草稿多附件直发和附件追加 |
| `send-picker` | 点选按钮、Esc、内置／自定义网站配置、控件短暂替换、原生拖放 |
| `ai-web` | ChatGPT／Gemini／Claude 模拟编辑器和附件、网站切换、控件歧义、明确选择器与快捷键 |
| `unified-templates` | 生产权限下旧配置迁移、单入口编辑、划词等待与发送前勾选保留、发送后全部预设自动取消勾选、Pointer Events 拖动／Esc／排序冲突、禁用光标、320／420px 高级设置与附件区域按钮、局部附件和正文单次采集、多附件单次发送、用户文件保护、追加快照与新正文共存、空草稿直发、替换成功及失败、富文本追加与无划词普通发送 |
| `motion` | 70k 字正文下的输入／闲置差量更新、流式文本、滚动和 100 条预设排序计数及 DevTools 轨迹；快速重开、焦点、Esc、减少动态效果、销毁清理、视口定位合并，以及构建后原生弹窗的关闭和忙碌限制 |

每组失败都会指出测试阶段。日志、结果 JSON、页面截图及隔离配置保存在忽略的 `tmp/browser/`；脚本的 `finally` 关闭浏览器和本地服务。`fixtures/test-key.pem` 是公开的本地测试专用密钥，仅用于忽略证书校验的回环 HTTPS fixture，不能用于部署或任何真实服务。

单元测试使用 `npm test`。浏览器回归证明构建产物、扩展权限、消息、编辑事件和模拟原站协议能共同工作；真实网站的布局、登录、服务端行为和账号能力需要单独人工验证，见 [验证记录](validation.md)。

动画与性能测量的指标定义、基线和验证边界见 [流畅度验证](motion-validation.md)。`motion` 的增强层测量使用源码临时构建和模拟后台，侧栏弹窗使用当前 `dist`；测量钩子不进入生产扩展。

维护测试时，先检查 fixture 是否仍对应当前协议。页面上的按钮出现不等于成功：断言最终发送次数、采集次数、完整正文和草稿／附件保护。不要通过删掉安全断言来消除失败。
