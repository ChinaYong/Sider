# 正文提取三方对照（2026-10-05）

本文的“当前实现”指借鉴改造前的工作区快照。后续已实现的改动和前后验证见[借鉴 Defuddle 的正文提取改进](extraction-improvement.md)；以下原始三方对照数据保留。

结论：保留现有 Readability 基础，优先修复外围过滤和遗漏补偿，并借鉴 Defuddle 的开放 Shadow DOM 与代码结构处理。当前证据不支持直接把提取引擎全部替换为 Defuddle。

这轮比较发现一个此前构造测试没有覆盖的重要问题：MDN 加载完成后的 20 个可见代码块位于开放的 Shadow DOM 中。当前实现与原生 Readability 都遗漏了全部 20 个，Defuddle 保留了全部 20 个。当前实现的折叠内容、脚注和事实补偿仍有实际价值，同时会误删名称类似噪音的正文，或补回推广区域。

## 方法与边界

- 实际浏览器：Tabbit / Chromium 152.0.7977.83；在新建测试标签页运行，未读取或改动用户原有标签页。
- 固定版本：项目中的 `@mozilla/readability 0.6.0`、独立测试目录中的 `defuddle 0.19.4`、项目中的 `turndown 7.2.4`。
- 当前实现直接调用 `src/content/extract.js` 的 `extractPage`；原生 Readability 使用文档副本及 DOM serializer；Defuddle 使用浏览器核心入口和默认过滤/规范化设置，关闭异步抓取。
- 三方共用项目现有 Markdown 转换器，避免把表格、围栏等转换差异全部算作提取引擎差异。Defuddle 自身对 HTML 的规范化仍然生效。因此该结果不代表三者各自默认 Markdown 输出的比较。
- 18 个构造页面中，15 个用于正文质量；输入草稿排除、加载占位拒绝、`aria-busy` 拒绝这 3 个扩展集成职责单独统计。
- 6 个公开网页使用同一次采集的 DOM 比较。标注范围来自实际页面结构；只评价当时可见内容，Spring 的 See Also 列表不计入正文。
- 公开页面的“段落样本”使用可见叶级段落、列表项、定义项中最长文本节点的首/中/尾片段；代码样本使用去除隐藏行号后文本的首/尾片段。匹配前统一 Unicode、去标点和空白，并去除 Markdown 链接地址。它们是覆盖检查，不是逐字准确率，也不证明整个段落或代码的语法完全正确。
- 每个页面预热 2 次，三方轮换执行顺序，各采样 7 次，报告中位耗时；比较前后检查页面 `documentElement.outerHTML` 没有改变。
- 固定页面刻意覆盖本项目的已知问题，不能把通过比例当作全网准确率。公开样本以技术文档为主，未覆盖登录内容、跨域 iframe、图片 OCR、封闭 Shadow DOM 或所有 SPA 状态。

完整清单、源码指纹、原始输出、时间样本与冻结 DOM 位于 `.tmp/extraction-comparison/`。Defuddle 仅安装在该测试目录，项目的生产依赖、源码和 `dist` 未因本轮比较变更。

## 固定页面结果

| 比较项 | 当前实现 | 原生 Readability | Defuddle |
|---|---:|---:|---:|
| 15 个正文质量用例通过数 | 12 | 9 | 9 |
| 3 个扩展集成要求通过数 | 3 | 0 | 0 |
| 正文用例各页面中位耗时的中位数 | 0.4 ms | 0.3 ms | 1.0 ms |

原生库没有项目的加载状态与可编辑区域策略，集成要求的结果说明这些保护仍需由扩展提供，不能由此认定库自身存在缺陷。

当前实现的 3 个正文失败用例：

1. 正常部署建议采用 `section#recommendations`，其中重要迁移限制被删除。
2. `div.related` 内存在 `aside[role="note"]`，外层先被删除，内部事实说明无法恢复。三方在这一构造页面中都遗漏了说明。
3. 无 `main/article` 的页面，Readability 已排除的侧栏被当前遗漏补偿重新加入。

原生 Readability 的主要遗漏包括折叠限制说明、列表或引用中被部分过滤的条目，以及事实脚注。Defuddle 保留了部分被原生 Readability 遗漏的结构，也出现选错更长文章、保留链接列表噪音、遗漏普通 `role="note"` 说明和脚注的问题。三者没有一个通过全部用例。

## 公开网页结果

表中每格为“保留段落样本 / 保留代码样本”，分母分别列在样本数中。

| 页面 | 样本数：段落 / 代码 | 当前实现 | 原生 Readability | Defuddle |
|---|---:|---:|---:|---:|
| [Vue 中文侦听器](https://cn.vuejs.org/guide/essentials/watchers) | 24 / 21 | 24 / 21 | 24 / 21 | 24 / 21 |
| [MDN 中文 Fetch](https://developer.mozilla.org/zh-CN/docs/Web/API/Fetch_API/Using_Fetch) | 30 / 20 | 30 / 0 | 30 / 0 | 30 / 20 |
| [Python 中文数据结构](https://docs.python.org/zh-cn/3/tutorial/datastructures.html) | 39 / 33 | 39 / 33 | 38 / 33 | 38 / 33 |
| [Spring REST 服务](https://spring.io/guides/gs/rest-service) | 47 / 14 | 47 / 14 | 45 / 14 | 47 / 14 |
| [阮一峰 Fetch API 教程](https://www.ruanyifeng.com/blog/2020/12/fetch-tutorial.html) | 47 / 30 | 47 / 30 | 47 / 30 | 46 / 30 |
| [Defuddle 官方文档](https://defuddle.md/docs) | 32 / 19 | 32 / 19 | 31 / 19 | 31 / 18 |

值得单独看待的差异：

- **Vue：**当时可见代码块为 21 个，当前实现输出 21 个；另外两者输出 34 个，也收进了被 API 模式切换隐藏的示例。按当前项目的可见内容策略，较短的输出不是正文遗漏。当前实现与 Defuddle 还保留了“在 GitHub 上编辑此页”入口。
- **MDN：**正确的加载完成条件是 20 个 `mdn-code-example` 的开放 Shadow Root 中已经存在 `pre`，不是普通 DOM 中存在 20 个 `pre`。加载完成后普通 DOM 的 `pre` 数量为 0，Shadow DOM 中为 20。当前实现和原生 Readability 输出没有这些代码，Defuddle 全部保留。当前实现还补回了翻译切换、贡献入口和页面更新时间等外围内容。
- **Python：**当前实现补回了有关可变对象与连续调用的脚注；另外两者遗漏该脚注。
- **Spring：**原生 Readability 遗漏了两段有关请求地址和访问步骤的说明，当前实现和 Defuddle 保留了它们。当前实现还收进了 Spring Academy 推广及导航入口。Defuddle 虽保住正文，其 HTML 规范化把若干 `name`、`World`、`GET` 等行内代码改成独立代码块，输出 83 个围栏块，原页面和另外两者为 14 个；阅读结构因此变差。
- **Defuddle 文档：**当前转换器对以 `span.doc-code-line` 表示的视觉代码行直接取 `textContent`，多行代码变成一行；原生 Readability 通过同一转换器也有这个问题，虽然首尾文本覆盖检查通过。Defuddle 能重建换行，但浏览器用法示例末尾的 `console.log(result.author)` 行被遗漏，因而代码片段检查为 18/19。需要同时验证代码文本与行结构。
- **阮一峰：**当前实现和原生 Readability 保留全部标注样本。Defuddle 漏掉一条参考链接文字；未把这类参考资料遗漏等同于正文核心事实丢失。

## 性能与体积

| 页面 | 当前实现 | 原生 Readability | Defuddle |
|---|---:|---:|---:|
| Vue | 19.1 ms | 18.4 ms | 28.1 ms |
| MDN | 10.5 ms | 9.8 ms | 34.0 ms |
| Python | 34.0 ms | 22.9 ms | 45.8 ms |
| Spring | 12.4 ms | 13.4 ms | 40.2 ms |
| 阮一峰 | 22.7 ms | 13.9 ms | 31.3 ms |
| Defuddle 文档 | 19.7 ms | 11.6 ms | 25.2 ms |

这些是解析及 Markdown 转换时间，不包含导航和资源加载。MDN 两个较快结果同时漏掉 20 个代码块，不能把耗时差直接解释为同等工作量下的效率优势。

在同一 esbuild、Chrome 116 目标和压缩选项下，单独打包提取库的大小为：Readability 34,680 字节，Defuddle 浏览器核心 330,884 字节。该数字不是 gzip 大小，也不是最终扩展安装包增量；直接替换或同时引入还需重新测量完整生产构建。

## 建议的改进顺序

1. 修正当前名称过滤：结合结构和内容判断，保护容器内部的事实说明，避免在识别正文之前不可恢复地删掉内容。
2. 收紧遗漏补偿：无语义主区域时先确定正文容器；贡献、分享、云端学习推广等区域不应仅因“未出现在识别结果中”就补回。
3. 参考 Defuddle 对开放 Shadow DOM 的处理，先覆盖已确认的 MDN 代码场景，并保留隐藏内容、可编辑区域和范围限制。
4. 为视觉分行的代码结构恢复换行，检查最后一行、缩进和围栏；覆盖 `span` 表示代码行的页面。
5. 对以上修改重跑固定样本及冻结的实际页面。暂不引入第二个完整提取引擎，避免承担已测出的体积和结构转换代价。

## 复查与复跑

主要文件：

- `.tmp/extraction-comparison/corpus.mjs`：固定页面、事实标记和公开网址。
- `.tmp/extraction-comparison/prepare.mjs`：测试适配器、版本及源码 SHA-256、相同设置下的库大小。
- `.tmp/extraction-comparison/tabbit-fixtures.js`：固定样本的浏览器执行程序。
- `.tmp/extraction-comparison/tabbit-public-gold.js`：实际网页采集和标注；每次执行处理下一组 3 个页面。
- `.tmp/extraction-comparison/finalize.mjs`：去除隐藏行号、排除 Spring See Also，生成最终覆盖检查和统计。
- `.tmp/extraction-comparison/summary.json`：最终统计、具体遗漏和噪音。
- `.tmp/extraction-comparison/outputs/`：每页三方完整输出、时间样本、冻结 HTML；MDN 另存开放 Shadow DOM 中的代码。

复跑时先运行 `node .tmp/extraction-comparison/prepare.mjs`，在新的 Tabbit 对照任务中按技能要求执行固定样本程序，再执行两次公开页面程序，最后运行 `node .tmp/extraction-comparison/finalize.mjs`。公开网址和网站样式可能变更；逐次结果已经冻结保存，复跑结果应与本次记录分开留存。

初始误写的博客网址返回 404，未计入最终样本；替换为核实后的 Fetch API 教程。MDN 首次只等待普通正文文字就绪，后来发现代码迁移到 Shadow DOM，最终统计使用代码完成装载后的同次 DOM 对照。代码块检查排除了隐藏行号，普通 `text` 代码语言允许无语言标签的正确围栏。浏览器记录中出现 Vue、Spring 的图片加载或站点脚本警告，不将其描述为提取库错误，也不宣称整个真实网站无控制台问题。
