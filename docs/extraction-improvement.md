# 借鉴 Defuddle 的正文提取改进（2026-10-05）

已将改进落实到 `src/content/extract.js`，并构建到 `dist`。本轮以[三方对照](extraction-comparison.md)中的工作区实现为修改前基线，保留 Readability、Turndown 和已有的事实补回机制。

## 借鉴与调整

参考了 [Defuddle](https://github.com/kepano/defuddle) 0.19.4 中 `flattenShadowRoots` 和 `extractStructuredText` 的处理思路，按本项目采集流程实现以下能力：

- 开放 Shadow DOM 在脱离原页面的副本中展开，支持嵌套根、已分配 slot 和 slot 的默认内容。以中性元素替代宿主，排除未分配的 light DOM；空的开放根不会暴露宿主中未呈现的文字。隐藏、输入、草稿、脚本和复制按钮仍被排除。
- 代码仅在 `pre` 内按行恢复，支持常见行包装元素、`br` 和行号栏，保留缩进、空行、最后一行及安全围栏。增加 `brush: js`、`data-lang` 和 `data-language` 的语言识别。普通行内 `code` 保持行内格式。
- `related`、`recommendations` 等宽泛名称结合外围语义和链接占比判断，保留部署建议章节与嵌套事实说明。
- 无 `main/article` 时尝试已知正文容器；布局主区域内，拥有同一 H1 且占主要文本的正文容器成为识别和补回边界。没有可信正文区域时，不再将整页 body 补回 Readability 的结果。
- 去除文档的编辑链接、翻译切换区、站点页脚等界面区域。正文中的普通脚注页脚和复杂表格继续保留。

没有加入生产 Defuddle 依赖；它仍只存在于之前的独立对照目录。未增加权限或设置。闭合 Shadow DOM、跨域 iframe、未加载内容和图片文字仍不在本次采集范围内。

## 固定页面前后对照

Tabbit / Chromium 152.0.7977.83 中，同一 DOM 上执行修改前后版本，预热 2 次，各采样 7 次并交替执行顺序。检查 light DOM 与所有可访问 Shadow DOM 均未被提取过程改变。

| 检查集 | 修改前 | 修改后 |
|---|---:|---:|
| 原有 15 个正文质量用例 | 12/15 | 15/15 |
| 原有 3 个草稿/加载状态用例 | 3/3 | 3/3 |
| 新增 5 个 Shadow DOM、代码结构与正文范围用例 | 0/5 | 5/5 |
| 合计 | 15/23 | 23/23 |

修复了此前复现的三个退步：部署建议误删、外层 `related` 导致事实说明误删、无语义主区域时恢复侧栏。新增用例包含已分配/未分配 slot、嵌套 Shadow DOM、空根、视觉代码行和 `br` 换行。

## 六个公开页面

沿用原对照标注的段落和代码片段。同一真实页面 DOM 上比较修改前后输出，MDN 等待 20 个开放根中的代码完成加载。片段覆盖不是逐字准确率；另对 Defuddle 文档进行了完整代码行比较。

| 页面 | 段落样本，前 → 后 | 代码样本，前 → 后 | 其他结果 |
|---|---:|---:|---|
| [Vue 侦听器](https://cn.vuejs.org/guide/essentials/watchers.html) | 24 → 24 | 21 → 21 | 移除编辑链接，隐藏的另一 API 模式示例未混入 |
| [MDN 使用 Fetch](https://developer.mozilla.org/zh-CN/docs/Web/API/Fetch_API/Using_Fetch) | 30 → 30 | 0 → 20 | 保留全部 Shadow DOM 代码和语言，移除翻译/贡献界面 |
| [Python 数据结构](https://docs.python.org/zh-cn/3/tutorial/datastructures.html) | 39 → 39 | 33 → 33 | 原有脚注保留 |
| [Spring REST 服务](https://spring.io/guides/gs/rest-service) | 47 → 47 | 14 → 14 | 排除云课程推广和顶部 All guides 导航，行内代码保持行内格式 |
| [阮一峰 Fetch 教程](https://www.ruanyifeng.com/blog/2020/12/fetch-tutorial.html) | 47 → 47 | 30 → 30 | 引用中的代码保持完整 |
| [Defuddle 文档](https://defuddle.md/docs) | 32 → 32 | 19 → 19 | 逐行精确匹配由 6/19 提升到 19/19，保留最终 author 输出行和开头介绍 |

Spring 的正文许可证句子也包含 “All guides”。噪音检查改为匹配同名 Markdown 导航链接，避免把许可证文字误判为顶部导航。该调整只改变测试标注；正文许可证仍被保留。

一次最终采样的中位耗时（毫秒）：Vue 16.8 → 17.4；MDN 10.6 → 31.9；Python 48.5 → 41.7；Spring 16.1 → 16.5；阮一峰 23.1 → 27.2；Defuddle 19.5 → 20.4。MDN 的增长包含原来完全未处理的 20 个代码块。本次以完整性和噪音控制为目标，不作普遍提速结论。

构造页面围绕已知问题，公开样本主要是技术文档。这些结果不能当作全网提取准确率，也不能保证所有页面布局都能识别。

## 生产路径验证与交付

- `npm run check`：504 项测试全部通过并完成构建；新增 12 项提取回归。初次普通进程因既有 dist 写权限限制构建失败，使用限定项目范围的权限完成最终构建。
- 隔离 Chromium 148.0.7778.96 加载实际生产权限与 `dist`，通过原生扩展 action 授予 activeTab。真实 `ISOLATED` 内容脚本能够读取网页 MAIN 环境创建的开放 Shadow DOM，嵌套根、slot、缩进、语言、事实说明与折叠内容采集通过；隐藏/草稿/UI 未进入结果，DOM 未被改动。修改 Shadow DOM 后再走 `SIDER_PAGE_CAPTURE` 可取得最新内容。
- 最终生产扩展在本地 HTTPS 聊天 fixture 中通过 14 组发送链检查，覆盖发送时刷新一次、等待上传、重复发送、失败阻断、用户文件保护、取消、导航、加载状态与重试。70,046 字符的正文和尾标记完整保留，控制台错误为空。没有向真实 AI 对话发送测试消息。
- 真实公开网页检查期间 Vue、Spring 有原站图片加载及脚本警告；不将其描述为全程无网页脚本错误。临时测试标签页已关闭，Tabbit 任务正常结束。
- `dist/page-content.js` 从 149,978 字节增至 153,745 字节，增加 3,767 字节（约 3.7 KiB，2.5%）。版本仍为 0.5.12，原 ZIP 保持为此前产物。使用本次代码需要重新加载指向 `dist` 的扩展，并刷新来源页面、重新打开侧栏。

原始输出、固定页面清单、逐行代码标注、耗时样本、源码指纹和生产集成记录位于 `.tmp/extraction-improvement/`，原来的 `.tmp/extraction-comparison/` 基线证据保留。

修改前 `extract.js` SHA-256：`04730d23cde54afc9e1b4b4d30d6cd83de678622011720fa94cf39028ec5294b`。修改后：`35f1be086070576e072207541d63f2a7d3087b983349642e3aa181b6dd4b7fa7`。
