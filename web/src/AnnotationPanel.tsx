import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Trash2 } from 'lucide-react';
import { type Annotation, type ReaderIdentity, useAnnotations } from './readerState';
import Modal from './Modal';
import { useDismissibleLayer } from './readerNavigation';

export interface AnnotationTarget {
  line: number;
  snippet: string;
  id?: string;
}
export function AnnotationPanel({
  identity,
  target,
  setTarget,
  notify,
  code = false,
  listOpen = false,
  closeList = () => {},
}: {
  identity: ReaderIdentity;
  target: AnnotationTarget | null;
  setTarget: (target: AnnotationTarget | null) => void;
  notify: (message: string) => void;
  code?: boolean;
  listOpen?: boolean;
  closeList?: () => void;
}) {
  const { annotations, persist, error, legacy, sync, resolveConflict } = useAnnotations(
    identity,
    notify,
    code,
  );
  const [input, setInput] = useState('');
  const [baseline, setBaseline] = useState<Annotation | null>(null);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const editing = annotations.find((item) => item.id === target?.id);
  const open = !!target || legacyOpen;
  useDismissibleLayer(listOpen && !open, closeList);
  useDismissibleLayer(open, () => {
    setTarget(null);
    setLegacyOpen(false);
  });
  useEffect(() => {
    setInput(editing?.note || '');
    setBaseline(editing ? { ...editing } : null);
  }, [target]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panelRef.current?.contains(document.activeElement)) return;
      const items = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea',
      );
      if (!items?.length) return;
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      previous?.focus();
    };
  }, [open]);
  const close = () => {
    setTarget(null);
    setLegacyOpen(false);
  };
  useEffect(() => {
    const beforeUpdate = (event: Event) => {
      if (target && input !== (baseline?.note || '')) event.preventDefault();
    };
    window.addEventListener('codesip:before-update', beforeUpdate);
    return () => window.removeEventListener('codesip:before-update', beforeUpdate);
  }, [target, input, baseline]);
  const editorVersion = () => {
    // An acknowledgement of our own unchanged content may advance the version.
    // A remote edit while the drawer is open must still conflict with this draft.
    if (
      baseline &&
      editing &&
      baseline.note === editing.note &&
      baseline.snippet === editing.snippet &&
      baseline.line === editing.line
    )
      return editing.updatedAt ?? baseline.updatedAt;
    return baseline?.updatedAt;
  };
  const save = () => {
    if (!target || !input.trim()) return;
    const item: Annotation = {
      id: editing?.id || crypto.randomUUID(),
      line: target.line,
      snippet: target.snippet.slice(0, 2000),
      note: input.trim(),
      createdAt: editing?.createdAt || Date.now(),
      updatedAt: editorVersion(),
      localRev: (editing?.localRev || 0) + 1,
      syncStatus: 'pending',
    };
    if (
      persist(
        [...annotations.filter((value) => value.id !== item.id), item].sort(
          (a, b) => a.line - b.line,
        ),
        { type: 'save', item },
      )
    ) {
      close();
    }
  };
  return (
    <>
      {(annotations.length > 0 || legacy.length > 0 || error) && (
        <section className="reader-annotations" aria-label="阅读批注">
          {error && <p role="alert">{error}</p>}
          {annotations.length > 0 && (
            <>
              <div className="annotations-title">批注 · {annotations.length}</div>
              <div className="annotations-pills">
                {annotations.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`annotation-pill status-${item.syncStatus || 'synced'}`}
                    onClick={() =>
                      setTarget({ line: item.line, snippet: item.snippet, id: item.id })
                    }
                  >
                    <strong>L{item.line}</strong>{' '}
                    {item.syncStatus === 'synced' && <span className="pill-badge">已同步</span>}
                    {item.syncStatus === 'pending' && (
                      <span className="pill-badge badge-pending">草稿</span>
                    )}
                    {item.syncStatus === 'conflict' && (
                      <span className="pill-badge badge-conflict">冲突</span>
                    )}
                    {item.syncStatus === 'deleting' && (
                      <span className="pill-badge badge-deleting">待删除</span>
                    )}
                    {item.note.length > 40 ? item.note.slice(0, 40) + '…' : item.note}
                  </button>
                ))}
              </div>
            </>
          )}
          {legacy.length > 0 && (
            <button
              className="legacy-annotations-button"
              type="button"
              onClick={() => setLegacyOpen(true)}
            >
              查看旧版批注（{legacy.length}）
            </button>
          )}
        </section>
      )}
      {listOpen &&
        !open &&
        createPortal(
          <Modal title="批注列表" close={closeList} scrimClassName="reader-sheet-scrim">
            <div className="reader-annotation-list">
              {error && <p role="alert">{error}</p>}
              {!annotations.length && (
                <p className="editor-help">还没有批注。选中文字后，点底部“批注”记录想法。</p>
              )}
              {annotations.map((item) => (
                <button
                  type="button"
                  className="annotation-list-item"
                  key={item.id}
                  onClick={() => {
                    closeList();
                    setTarget({ line: item.line, snippet: item.snippet, id: item.id });
                  }}
                >
                  <span>
                    第 {item.line} 行 ·{' '}
                    {item.syncStatus === 'pending'
                      ? '待同步'
                      : item.syncStatus === 'conflict'
                        ? '有冲突'
                        : item.syncStatus === 'deleting'
                          ? '待删除'
                          : '已同步'}
                  </span>
                  <blockquote>{item.snippet}</blockquote>
                  <p>{item.note}</p>
                </button>
              ))}
            </div>
          </Modal>,
          document.body,
        )}
      {open &&
        createPortal(
          <>
            <div className="bottom-sheet-backdrop" onClick={close} />
            <div
              ref={panelRef}
              className="code-annotation-drawer"
              role="dialog"
              aria-modal="true"
              aria-label={legacyOpen ? '导入旧版批注' : editing ? '编辑批注' : '添加批注'}
            >
              <div className="drawer-header">
                <strong>
                  {legacyOpen
                    ? '旧版批注'
                    : `${code ? '代码批注' : '笔记批注'} · 第 ${target!.line} 行`}
                </strong>
                <button type="button" className="icon-button" aria-label="关闭批注" onClick={close}>
                  <X size={18} />
                </button>
              </div>
              {legacyOpen ? (
                <div className="drawer-body">
                  <p className="annotation-help">
                    旧记录没有项目归属。确认属于当前文件后导入，原记录会保留。
                  </p>
                  {legacy.map((item) => (
                    <div className="legacy-annotation" key={item.id}>
                      <blockquote>{item.snippet || `第 ${item.line} 行`}</blockquote>
                      <p>{item.note}</p>
                      <button
                        className="button secondary"
                        onClick={() => {
                          if (
                            persist(
                              [...annotations, item].sort((a, b) => a.line - b.line),
                              { type: 'save', item },
                            )
                          )
                            notify('已导入当前文件');
                        }}
                      >
                        导入此条
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  {target!.snippet && (
                    <div className="drawer-snippet">
                      <code>{target!.snippet}</code>
                    </div>
                  )}
                  <div className="drawer-body">
                    {editing?.syncStatus === 'conflict' && (
                      <div className="annotation-conflict-banner" role="alert">
                        <strong>版本冲突</strong>
                        <p>服务器版本已改变。选择要保留的版本后，可继续编辑。</p>
                        <div className="conflict-actions">
                          <button
                            type="button"
                            className="button primary compact"
                            onClick={async () => {
                              if (await resolveConflict(editing.id, 'local')) close();
                            }}
                          >
                            {editing.pendingDelete ? '确认删除服务器版本' : '保留我的版本'}
                          </button>
                          <button
                            type="button"
                            className="button secondary compact"
                            onClick={async () => {
                              if (await resolveConflict(editing.id, 'remote')) close();
                            }}
                          >
                            采用服务器版本
                          </button>
                        </div>
                      </div>
                    )}
                    {editing?.syncStatus === 'deleting' && (
                      <div className="annotation-deleting-banner" role="alert">
                        该批注已标记为待从自习室删除（离线保留）。
                      </div>
                    )}
                    {editing &&
                      editing.syncStatus !== 'conflict' &&
                      (editing.syncStatus === 'pending' ||
                        editing.syncStatus === 'deleting' ||
                        editing.pendingDelete) && (
                        <div className="annotation-status-bar">
                          <span className="status-desc">
                            {editing.pendingDelete || editing.syncStatus === 'deleting'
                              ? '待删除同步（离线）'
                              : '待同步草稿（未上传）'}
                          </span>
                          {sync && (
                            <button
                              type="button"
                              className="button text-button compact"
                              onClick={() => sync()}
                            >
                              立即重试同步
                            </button>
                          )}
                        </div>
                      )}
                    <p className="annotation-help">
                      {editing?.syncStatus === 'pending'
                        ? '本机草稿（未同步到自习室）。'
                        : editing?.syncStatus === 'synced'
                          ? '已同步到自习室。'
                          : '支持在线同步自习室与离线本机草稿。原文保持只读。'}
                    </p>
                    {editing?.lastError && (
                      <p className="annotation-help" role="status">
                        {editing.lastError}
                      </p>
                    )}
                    <textarea
                      ref={inputRef}
                      className="drawer-input"
                      aria-label="批注内容"
                      rows={4}
                      maxLength={10000}
                      readOnly={editing?.syncStatus === 'conflict'}
                      placeholder="记录你的理解或疑问"
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                    />
                  </div>
                  <div className="drawer-actions">
                    {editing && (
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => {
                          const deleteItem: Annotation = {
                            ...(baseline || editing),
                            updatedAt: editorVersion(),
                            syncStatus: 'deleting',
                            pendingDelete: true,
                          };
                          if (persist(annotations, { type: 'delete', item: deleteItem })) close();
                        }}
                      >
                        <Trash2 size={14} />
                        {editing.syncStatus === 'deleting' ? '重试删除' : '删除批注'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="button primary"
                      disabled={!input.trim() || !!error || editing?.syncStatus === 'conflict'}
                      onClick={save}
                    >
                      保存批注
                    </button>
                  </div>
                </>
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
