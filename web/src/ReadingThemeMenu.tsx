import Modal from './Modal';
import type { ReaderTheme } from './readerState';

const themes = [
  { id: 'paper-light', dot: 'paper', name: '素笺暖白', detail: '棉纸柔和底，日光讲义质感' },
  { id: 'warm-slate', dot: 'slate', name: '松烟暖灰', detail: '夜间低对比护眼暗调' },
  { id: 'sepia-parchment', dot: 'sepia', name: '羊皮纸棕', detail: '沉浸古籍温润色调' },
] as const;

export default function ReadingThemeMenu({
  theme,
  select,
  close,
}: {
  theme: ReaderTheme;
  select: (value: ReaderTheme) => void;
  close: () => void;
}) {
  return (
    <Modal title="阅读主题" close={close}>
      <div className="theme-drawer-options">
        {themes.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`theme-drawer-item ${theme === option.id ? 'active' : ''}`}
            aria-pressed={theme === option.id}
            onClick={() => {
              select(option.id);
              close();
            }}
          >
            <div className={`theme-dot dot-${option.dot}`} />
            <div className="theme-item-text">
              <strong>{option.name}</strong>
              <span>{option.detail}</span>
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}
