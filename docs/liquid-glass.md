# 液态玻璃设计与验证

设计依据为用户提供的 design.md。采用 Paper #F3F2ED、Graphite Ink #202929、Deep Sea #25414A、Salt Mist #E4EFEB 和 Sage Focus #557B79。

- 正文、代码和项目卡片保留稳定的实色底。
- 悬浮导航、搜索、按钮和临时弹层使用玻璃边缘高光及背景折射。
- `web/src/GlassEffects.tsx` 根据圆角曲面的法线和折射角生成位移图。中心保持中性，曲面位移集中在窄边带，随控件尺寸更新。
- Chromium 通过 SVG feImage + feDisplacementMap 与 backdrop-filter 显示背景弯折；其他浏览器使用磨砂降级。
- 不使用持续自动变形或彩虹发光。按下反馈约 110ms，释放约 420ms；手机导航支持点击、拖动、取消恢复和键盘操作。
- 尊重减少动态和减少透明度偏好，保留键盘焦点；临时弹层支持 Escape、焦点约束与返回焦点。

浏览器测试在同一网格与同一控件位置，分别拍摄 SVG 折射和降级外观，并确认像素输出不同。测试曾发现构建压缩只保留 webkit 前缀导致 Chromium 折射失效，现通过声明顺序及实际渲染测试覆盖。截图保存在 `.local/screenshots/`，不含真实笔记。

此光学实现为本项目自行编写，没有复制参考仓库代码。
