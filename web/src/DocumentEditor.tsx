import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import Modal from './Modal';
import { useDismissibleLayer } from './readerNavigation';
import type { DocumentCopyController } from './documentCopies';

export function DocumentEditor({
  open,
  close,
  document,
  path,
  notify,
}: {
  open: boolean;
  close: () => void;
  document: DocumentCopyController;
  path: string;
  notify: (message: string) => void;
}) {
  const [backedUp, setBackedUp] = useState(false);
  const dismiss = () => {
    if (document.busy) return;
    if (document.storageError && document.draft && !backedUp) {
      notify(document.storageError);
      return;
    }
    close();
  };
  useDismissibleLayer(open, dismiss);
  useEffect(() => {
    const guard = (event: Event) => {
      if (open && document.draft) event.preventDefault();
    };
    window.addEventListener('codesip:before-update', guard);
    return () => window.removeEventListener('codesip:before-update', guard);
  }, [open, document.draft]);
  if (!open) return null;
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([document.content], { type: 'text/markdown;charset=utf-8' }),
    );
    const a = window.document.createElement('a');
    a.href = url;
    a.download = (path.split('/').pop() || '笔记.md').replace(/\.md$/i, '-我的编辑版.md');
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBackedUp(true);
  };
  return createPortal(
    <Modal title="编辑文档" close={dismiss} scrimClassName="document-editor-scrim">
      <p className="editor-help">保存为“我的编辑版”，电脑中的 Obsidian 原文不变。</p>
      <div className="document-editor-status" role="status">
        {document.busy
          ? '正在保存到云端…'
          : document.storageError
            ? '草稿尚未保存到本机'
            : document.draft
              ? '草稿已存本机 · 待保存到云端'
              : document.copy
                ? '编辑版已保存到云端'
                : '支持 Markdown 编辑'}
      </div>
      {(document.error || document.storageError) && (
        <div className="reader-feedback" role="alert">
          {document.storageError || document.error}
        </div>
      )}
      {document.conflict && (
        <div className="document-conflict">
          <details>
            <summary>查看云端版本</summary>
            <pre>{document.conflict.content}</pre>
          </details>
          <div className="editor-conflict-actions">
            <button
              type="button"
              className="button secondary"
              disabled={document.busy}
              onClick={document.adoptRemote}
            >
              采用云端版本
            </button>
            <button
              type="button"
              className="button primary"
              disabled={document.busy}
              onClick={() => void document.save(document.conflict!.updatedAt)}
            >
              保留我的编辑
            </button>
          </div>
        </div>
      )}
      <textarea
        aria-label="文档内容"
        className="document-editor-input"
        spellCheck={false}
        maxLength={500000}
        readOnly={document.busy || !!document.conflict}
        value={document.content}
        onChange={(e) => {
          setBackedUp(false);
          document.change(e.target.value);
        }}
      />
      <div className="document-editor-actions">
        <button type="button" className="button secondary" onClick={download}>
          下载备份
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={document.busy}
          onClick={dismiss}
        >
          返回阅读
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!document.draft || document.busy || !!document.conflict}
          onClick={async () => {
            if (await document.save()) {
              notify('我的编辑版已保存到云端');
              close();
            }
          }}
        >
          {document.busy ? '保存中…' : '保存编辑版'}
        </button>
      </div>
    </Modal>,
    window.document.body,
  );
}
