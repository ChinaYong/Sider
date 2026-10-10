# 浏览器回归

测试使用 Playwright、独立浏览器配置及本地 HTTP/HTTPS 页面，加载当前 `dist`。测试域名在该进程内映射到回环地址，不使用登录账号，也不向真实 AI 服务发送消息。

```sh
npm ci
npx playwright install chromium --no-shell
npm run test:browser
```

Linux CI 安装系统依赖可用 `npx --no-install playwright install --with-deps chromium --no-shell`。项目固定 Playwright 1.60.0，随包安装 Chromium 148.0.7778.96，以支持权限用例使用的 `Extensions.triggerAction` 调试接口；安装前先执行 `npm ci`，避免沿用旧依赖下载 Chromium 145。脚本使用完整 Chromium 通道，以支持扩展；不使用无头 shell。浏览器缺失时，失败信息会给出安装命令。

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
| `reference-source` | 所有窗口的来源选择、标题／网址搜索、键盘操作、320／420px 浅深色布局、勾选与原站文字／生成附件／用户附件／页面实例保留、新来源变量与正文、发送期间禁止切换、发送后保持来源、授权对象、来源关闭提示与快速返回 |
| `motion` | 70k 字正文下的输入／闲置差量更新、流式文本、滚动和 100 条预设排序计数及 DevTools 轨迹；快速重开、焦点、Esc、减少动态效果、销毁清理、视口定位合并，以及构建后原生弹窗的关闭和忙碌限制 |
| `ui-settings` | 320／420px 浅色与深色设置页、展开的网站分组和悬浮球设置、长表单固定保存栏、编辑中切换网站保护、保存反馈、重新打开后的状态、Esc 与焦点恢复；使用实际 HTML／CSS 和模拟设置后台 |
| `launcher` | 已授权网页自动注入、未授权网页／子框架不注入、真实鼠标点击开关原生标签页侧栏、再次点击关闭与第三次打开、页面刷新与工具栏／原生关闭事件同步、引用勾选和网页输入保持、拖动贴边且不误开关、位置保存与刷新、窄屏与深色、开关即时生效与脚本注册、配置备份 |
| `side-panel-capabilities` | 单独的原生承载测试扩展：窗口实例与独立实例存活、同一 iframe 的草稿／文件输入／页面状态保留、同 URL 转换是否重建、跨域隐藏及用户手势过期后的恢复、原生 API 关闭事件；输出能力门槛，详见 [关联模型与能力结果](side-panel-modes.md) |

每组失败都会指出测试阶段。日志、结果 JSON、页面截图及隔离配置保存在忽略的 `tmp/browser/`；脚本的 `finally` 关闭浏览器和本地服务。`fixtures/test-key.pem` 是公开的本地测试专用密钥，仅用于忽略证书校验的回环 HTTPS fixture，不能用于部署或任何真实服务。

单元测试使用 `npm test`。浏览器回归证明构建产物、扩展权限、消息、编辑事件和模拟原站协议能共同工作；真实网站的布局、登录、服务端行为和账号能力需要单独人工验证，见 [验证记录](validation.md)。

动画与性能测量的指标定义、基线和验证边界见 [流畅度验证](motion-validation.md)。`motion` 的增强层测量使用源码临时构建和模拟后台，侧栏弹窗使用当前 `dist`；测量钩子不进入生产扩展。

2026-10-09 UI 优化验证：`npm test` 600 项通过，构建通过；使用隔离 Chrome 运行 `motion` 与 `ui-settings`，分别通过 12 和 5 条检查，并人工查看了预设列表与浅色／深色设置截图。首次全量单测与浏览器并发期间一个划词时序用例失败，浏览器结束后独立重跑全量 600 项通过。本轮未验证真实账号网站，也未运行其余扩展集成测试组。

2026-10-09 侧栏入口验证：`npm test` 610 项通过，构建通过；隔离 Chromium 148.0.7778.96 的 `permissions`、`context`、`fresh-send`、`ai-web`、`send-picker`、`ui-settings` 和 `launcher` 七组通过。悬浮球实际点击通过原生 `sidePanel.onOpened` 确认来源标签页，拖动、刷新位置、窄屏、即时关闭／恢复、未授权页和子框架均已检查，并查看了设置页和悬浮球截图。旧浏览器用例的添加／完成编辑按钮改用固定 ID，发送控件用例按既有发送后自动取消勾选规则显式重新选择引用；本轮未验证真实账号网站。

2026-10-09 悬浮球开关验证：`npm test` 614 项通过，构建通过；隔离 Chromium 的 `launcher` 七项和 `context` 十五项通过。原生打开／关闭事件确认连续点击开关、刷新已打开的来源页后关闭、工具栏打开后关闭、原生关闭事件后重新打开，拖动不触发开关。单测另覆盖标签页隔离、关闭失败保留状态、后台重启恢复、延迟读取／响应不能覆盖新的原生状态。未验证真实账号网站。

2026-10-09 悬浮球名单与关闭范围验证：`npm test` 626 项全部通过，构建通过；隔离 Chromium 148.0.7778.96 的 `launcher` 11 项与 `ui-settings` 5 项通过。真实鼠标点击验证关闭范围选择、Esc 取消、仅本次隐藏后重复注入保持隐藏并在刷新恢复、全局关闭及多标签页恢复、网站关闭跨页面与刷新持久生效、黑／白名单快捷加入与移除、切换模式保留两份名单及配置导出。查看了浅色选择框、320×280 深色选择框和 320px 名单设置截图，极矮窗口三种选择与取消按钮均完整可见；设置组另验证 320／420px 浅色与深色布局、焦点和保存反馈。单测覆盖旧设置兼容、精确域名匹配、按需授权拒绝和保存失败可重试。结果与截图在 `tmp/browser/launcher-result.json`、`launcher-close-choices.png`、`launcher-close-320-dark.png` 和 `launcher-list-settings-320.png`，单测日志为 `tmp/launcher-rules-unit.log`。本轮验证使用本地 fixture，未验证真实账号网站。

2026-10-10 引用来源切换验证：`npm test` 688 项通过，构建通过；隔离 Chromium 148.0.7778.96 的 `permissions`、`context`、`fresh-send`、`unified-templates` 和 `reference-source` 五组最终通过，分别完成 8、15、17、13 和 6 条检查。实际创建第二个浏览器窗口，验证标题／网址搜索、键盘选择、来源变量、按需正文、授权对象、关闭提示、快速返回，以及切换前后原站草稿、生成附件、用户附件、勾选和同一 AI 页面实例保留。已查看 320px 深色、420px 浅色与来源关闭截图。修复导航后首次来源元信息被误判为切换、导致发送取消的问题，并增加单测；预设测试等待动画结束、拖动开始和勾选响应完成后再断言，保留附件及冲突保护检查。日志为 `tmp/reference-unit-final.log`、`tmp/reference-browser-final.log` 和 `tmp/reference-browser-presets.log`，截图与来源切换结果为 `tmp/browser/reference-source-*.png`、`reference-source-result.json`。本轮使用本地 fixture，未验证真实账号网站。

2026-10-10 配色与设置层级验证：`npm test` 688 项通过，构建通过；`ui-settings`、`motion`、`launcher`、`unified-templates`、`reference-source` 五组通过，共 47 条检查。人工查看了 320／420px 浅深色设置首页、Gemini 分组、打开方式和预设编辑截图，补充展开状态的截图覆盖。预设编辑返回列表时恢复顶部，避免沿用长表单的滚动位置影响拖动操作。浅色／深色各 8 组主要文字与背景配色的最低对比度分别为 5.02:1／6.58:1，此结果不代表完整无障碍审计。普通 Chrome 155 未加载测试扩展，扩展组改用已安装 Chromium 148 的隔离配置后通过；未使用现有账号配置，未验证真实 AI 网站。单测日志为 `tmp/ui-unit-tests-final.log`，配色计算为 `tmp/ui-contrast.json`，截图为 `tmp/browser/ui-*.png`、`motion-*.png` 和 `unified-editor-*.png`。

2026-10-10 CI 浏览器版本修复验证：固定 Playwright 1.60.0 与配套 Chromium 148.0.7778.96，`npm ci`、688 项单元测试和构建通过；全量 13 组浏览器回归命令退出码为 0，原先因缺少 `Extensions.triggerAction` 失败的 `permissions` 组 8 项检查全部通过。发送期间设置变化的单测改为等待取消反馈和实际提交，保留草稿、发送次数及最终格式断言。`side-panel-capabilities` 仍记录部分原生能力不支持，其统一承载实现门槛未通过，与回归命令成功是不同结果。本轮使用 Windows 下新下载的配套浏览器与隔离 fixture；GitHub Ubuntu runner 需提交并推送后另行确认。日志为 `tmp/ci-check.log`、`tmp/ci-browser.log`。

维护测试时，先检查 fixture 是否仍对应当前协议。页面上的按钮出现不等于成功：断言最终发送次数、采集次数、完整正文和草稿／附件保护。不要通过删掉安全断言来消除失败。
