# Sider icon

青绿色底图中的双引号代表网页划词引用，右侧竖条代表侧栏。图标采用实色背景，适用于浏览器工具栏的浅色和深色主题。

- `sider.png`：内置 imagegen 生成的原始图标。
- `icon-16.png`、`icon-32.png`：工具栏图标。
- `icon-48.png`、`icon-128.png`：扩展管理与安装界面图标。
- `npm run build` 将四个运行时图标复制到 `dist/icons/`；生成原图保留在源码目录。

使用内置 imagegen 工具生成。最终生成提示词：

```text
Use case: logo-brand.
Asset type: a finished square browser-extension icon for Sider, 1024 x 1024.
Create one very simple, professionally balanced flat geometric logo. The ENTIRE square canvas is filled with one perfectly uniform opaque emerald green color, #10A37F, edge to edge. The canvas background is an intentional solid part of the finished app icon. Absolutely no transparency, holes, shading, gradients, grain, glow, or shadows.
The foreground is a single centered compact pure-white symbol: two bold rounded opening quotation marks occupying the left two-thirds, and one tall solid white rounded vertical rectangle at the right representing a sidebar. Keep a clear green gap between the quote marks and the vertical panel. All three white shapes should have a visually unified weight, crisp clean smooth boundaries and generous padding from the canvas edges. The marks should be immediately legible as quotation marks and sidebar even at 16 pixels. Make this feel like a confident understated reading and citation tool, not a decorative illustration.
Style: flat vector-style identity mark, two colors only, sharp clean geometric construction, direct front view. A plain opaque square icon with simple solid colors. One final asset, no mockups, no text, no lettering, no contact sheet, no watermark, no border.
```

