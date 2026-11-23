import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import Modal from './Modal';
import { useDismissibleLayer } from './readerNavigation';
import {
  applyAppUpdate,
  checkForUpdates,
  getUpdateState,
  pageVersion,
  subscribeUpdates,
} from './appUpdates';
import './updates.css';

function bytes(value: number) {
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(value / 1024)} KB`;
}
export default function UpdatePrompt() {
  const state = useSyncExternalStore(subscribeUpdates, getUpdateState);
  const [open, setOpen] = useState(false);
  const [complete, setComplete] = useState(false);
  const promptedVersion = useRef<string | undefined>(undefined);
  const { phase, version, downloaded, total, message } = state;
  const pending = ['downloading', 'ready', 'applying', 'error'].includes(phase);
  const percent =
    phase === 'ready' || phase === 'applying'
      ? 100
      : Math.min(99, Math.floor((downloaded / Math.max(1, total)) * 100));
  useEffect(() => {
    const check = () => {
      setOpen(true);
      void checkForUpdates();
    };
    window.addEventListener('codesip:check-update', check);
    try {
      if (pageVersion && sessionStorage.getItem('codesip:updated-version') === pageVersion) {
        sessionStorage.removeItem('codesip:updated-version');
        setComplete(true);
      }
    } catch {
      /* Update feedback is optional when storage is unavailable. */
    }
    return () => window.removeEventListener('codesip:check-update', check);
  }, []);
  useEffect(() => {
    if (version && version !== promptedVersion.current && pending) {
      promptedVersion.current = version;
      // Keep typing uninterrupted. The update button remains available below.
      if (!document.querySelector('[role="dialog"]')) setOpen(true);
    }
  }, [state, version, pending]);
  useEffect(() => {
    if (!complete) return;
    const timer = setTimeout(() => setComplete(false), 5000);
    return () => clearTimeout(timer);
  }, [complete]);
  const close = () => {
    if (phase !== 'applying') setOpen(false);
  };
  useDismissibleLayer(open, close);
  const title =
    phase === 'downloading'
      ? '发现新版'
      : phase === 'ready'
        ? '新版已准备好'
        : phase === 'applying'
          ? '正在重载更新'
          : phase === 'error'
            ? '更新暂未完成'
            : phase === 'current'
              ? '已是最新版本'
              : phase === 'unsupported'
                ? '应用更新'
                : '检查应用更新';
  return (
    <>
      {complete && (
        <div className="update-complete" role="status">
          <Check size={16} /> 应用已更新
        </div>
      )}
      {pending && !open && (
        <button className="update-chip" onClick={() => setOpen(true)}>
          {phase === 'downloading' ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Download size={16} />
          )}
          {phase === 'downloading'
            ? `更新下载中 ${percent}%`
            : phase === 'error'
              ? '更新未完成 · 重试'
              : '新版已就绪'}
        </button>
      )}
      {open && (
        <Modal title={title} close={close} scrimClassName="update-scrim">
          <div className="update-content">
            {(phase === 'checking' || phase === 'applying') && (
              <p className="update-status" role="status">
                <LoaderCircle className="spin" size={18} />
                {phase === 'checking' ? '正在检查新版本…' : '正在打开新版…'}
              </p>
            )}
            {(phase === 'downloading' || phase === 'ready') && (
              <>
                <p className="modal-intro">
                  {phase === 'downloading'
                    ? '正在下载更新，可以继续阅读。下载完成后由你确认重载。'
                    : '更新已下载，重载后生效。已保存的批注、离线笔记和阅读位置会保留。'}
                </p>
                <div className="update-progress-label">
                  <span>
                    {phase === 'ready'
                      ? '下载完成'
                      : downloaded >= total && total > 0
                        ? '正在校验更新…'
                        : '正在下载'}
                  </span>
                  <strong>{percent}%</strong>
                </div>
                <progress
                  className="update-progress"
                  aria-label="更新下载进度"
                  value={percent}
                  max={100}
                />
                <p className="update-size">
                  {bytes(downloaded)} / {bytes(total)}
                </p>
              </>
            )}
            {phase === 'current' && (
              <p className="update-status">
                <Check size={20} /> 当前已是最新版本
              </p>
            )}
            {message && (
              <p className="update-message" role="alert">
                {message}
              </p>
            )}
            <div className="modal-buttons">
              <button className="button secondary" onClick={close} disabled={phase === 'applying'}>
                {phase === 'ready' || phase === 'downloading' ? '稍后处理' : '关闭'}
              </button>
              {phase === 'ready' && (
                <button className="button primary" onClick={applyAppUpdate}>
                  <RefreshCw size={16} />
                  重载更新
                </button>
              )}
              {phase === 'error' && (
                <button className="button primary" onClick={() => void checkForUpdates()}>
                  重试更新
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
