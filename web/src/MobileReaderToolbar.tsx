import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowDownToLine,
  Check,
  Layers3,
  LoaderCircle,
  Maximize2,
  FolderOpen,
  MoreHorizontal,
  RefreshCw,
  Search,
  UserRound,
  WrapText,
} from 'lucide-react';
import { useDismissibleLayer } from './readerNavigation';

interface Props {
  path?: string;
  libraryName?: string;
  directoryOpen?: boolean;
  isMarkdown: boolean;
  wrap: boolean;
  refreshing: boolean;
  offline: boolean;
  progress: string;
  offlineSaved: boolean;
  hasManifest: boolean;
  home: () => void;
  directory: () => void;
  focus: () => void;
  synchronize: () => void;
  search: () => void;
  toggleWrap: () => void;
  outline: () => void;
  saveOffline: () => void;
  account: () => void;
}

export default function MobileReaderToolbar(props: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  useDismissibleLayer(open, () => setOpen(false));
  const act = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <div className="mobile-reader-toolbar" ref={root}>
      <button className="icon-button" aria-label="返回项目列表" onClick={() => act(props.home)}>
        <ArrowLeft size={19} />
      </button>
      <button
        className="mobile-reader-file"
        aria-label="打开目录"
        aria-controls="project-file-tree"
        aria-expanded={props.directoryOpen}
        title={props.path || props.libraryName}
        onClick={() => act(props.directory)}
      >
        <FolderOpen size={18} />
        <span className="mobile-directory-label">目录</span>
        <span className="mobile-reader-filename">
          {props.path?.split('/').pop() || props.libraryName || '选择文件'}
        </span>
      </button>
      <button
        className="icon-button"
        aria-label="专注阅读"
        title="专注阅读"
        onClick={() => act(props.focus)}
      >
        <Maximize2 size={18} />
      </button>
      <button
        className="icon-button"
        aria-label="阅读工具"
        aria-controls="mobile-reader-actions"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={21} />
      </button>
      {open && (
        <div
          className="mobile-reader-actions"
          id="mobile-reader-actions"
          role="region"
          aria-label="阅读工具"
        >
          <button onClick={() => act(props.search)}>
            <Search size={19} />
            搜索项目内容
          </button>
          {!props.isMarkdown && (
            <button aria-pressed={props.wrap} onClick={props.toggleWrap}>
              <WrapText size={19} />
              自动换行{props.wrap && <Check size={16} className="action-check" />}
            </button>
          )}
          <button onClick={() => act(props.outline)}>
            <Layers3 size={19} />
            文件大纲
          </button>
          <button
            disabled={props.refreshing || !!props.progress}
            aria-label={props.refreshing ? '正在同步' : '同步'}
            onClick={props.synchronize}
          >
            <RefreshCw size={19} className={props.refreshing ? 'spin' : ''} />
            {props.refreshing ? '正在同步' : '同步'}
          </button>
          <button
            disabled={props.offline || !!props.progress || !props.hasManifest}
            aria-label={props.progress || (props.offlineSaved ? '已保存离线' : '保存离线')}
            onClick={props.saveOffline}
          >
            {props.progress ? (
              <LoaderCircle size={19} className="spin" />
            ) : props.offlineSaved ? (
              <Check size={19} />
            ) : (
              <ArrowDownToLine size={19} />
            )}
            {props.progress || (props.offlineSaved ? '已保存离线' : '保存离线')}
          </button>
          <button onClick={() => act(props.account)}>
            <UserRound size={19} />
            账号与退出
          </button>
        </div>
      )}
    </div>
  );
}
