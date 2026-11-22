import { useState, useMemo } from 'react';
import {
  Copy,
  Check,
  Maximize2,
  Minimize2,
  WrapText,
  AlignLeft,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

export interface CodeBlockProps {
  language?: string;
  code: string;
  childrenContent?: React.ReactNode;
  adjacentImage?: string;
}

export function CodeBlockView({ language = 'text', code, childrenContent, adjacentImage }: CodeBlockProps) {
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fontSize, setFontSize] = useState(13);
  const [compareMode, setCompareMode] = useState(false);

  const lines = useMemo(() => code.replace(/\r\n/g, '\n').split('\n'), [code]);
  const isLongCode = lines.length > 18;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback if clipboard API is restricted
    }
  };

  return (
    <>
      <div className={`code-block-card ${fullscreen ? 'is-fullscreen' : ''}`}>
        <div className="code-block-header">
          <div className="code-block-meta">
            <span className="code-lang-badge">{language.toUpperCase()}</span>
            <span className="code-line-counter">{lines.length} 行</span>
          </div>

          <div className="code-block-actions">
            {adjacentImage && (
              <button
                type="button"
                className={`code-tool-btn ${compareMode ? 'active' : ''}`}
                onClick={() => setCompareMode(!compareMode)}
                title="网课原图对照模式"
              >
                对照
              </button>
            )}

            <button
              type="button"
              className="code-tool-btn"
              onClick={() => setWrap(!wrap)}
              title={wrap ? '切换为横向滚动' : '切换为自动换行'}
            >
              {wrap ? <AlignLeft size={14} /> : <WrapText size={14} />}
              <span className="tool-btn-label">{wrap ? '换行' : '滚动'}</span>
            </button>

            <button
              type="button"
              className="code-tool-btn"
              onClick={handleCopy}
              title="复制代码"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              <span className="tool-btn-label">{copied ? '已复制' : '复制'}</span>
            </button>

            <button
              type="button"
              className="code-tool-btn"
              onClick={() => setFullscreen(!fullscreen)}
              title={fullscreen ? '退出全屏' : '全屏沉浸查看'}
            >
              {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
        </div>

        {compareMode && adjacentImage && (
          <div className="code-compare-image-pane">
            <img src={adjacentImage} alt="板书原图" loading="lazy" />
          </div>
        )}

        <div
          className={`code-content-wrapper ${
            isLongCode && !expanded && !fullscreen ? 'is-collapsed' : ''
          }`}
          style={{ fontSize: `${fontSize}px` }}
        >
          <pre className={`code-pre ${wrap ? 'wrap-mode' : 'scroll-mode'}`}>
            <code>{childrenContent || code}</code>
          </pre>

          {isLongCode && !expanded && !fullscreen && (
            <div className="code-fade-overlay">
              <button
                type="button"
                className="code-expand-btn"
                onClick={() => setExpanded(true)}
              >
                <ChevronDown size={14} />
                <span>展开全部（共 {lines.length} 行）</span>
              </button>
            </div>
          )}
        </div>

        {isLongCode && expanded && !fullscreen && (
          <div className="code-collapse-footer">
            <button
              type="button"
              className="code-collapse-btn"
              onClick={() => setExpanded(false)}
            >
              <ChevronUp size={14} />
              <span>收起超长代码</span>
            </button>
          </div>
        )}

        {fullscreen && (
          <div className="code-fullscreen-bar">
            <span className="font-adjust-label">字号:</span>
            <button
              type="button"
              className="font-adjust-btn"
              onClick={() => setFontSize((s) => Math.max(11, s - 1))}
            >
              A-
            </button>
            <span className="font-size-indicator">{fontSize}pt</span>
            <button
              type="button"
              className="font-adjust-btn"
              onClick={() => setFontSize((s) => Math.min(20, s + 1))}
            >
              A+
            </button>
            <button
              type="button"
              className="fullscreen-exit-btn"
              onClick={() => setFullscreen(false)}
            >
              退出
            </button>
          </div>
        )}
      </div>

      {fullscreen && (
        <div
          className="code-fullscreen-backdrop"
          onClick={() => setFullscreen(false)}
        />
      )}
    </>
  );
}
