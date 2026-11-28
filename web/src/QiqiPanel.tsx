import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Copy, MessageCircle, Plus, Send, Settings2, Square, Trash2, X } from 'lucide-react';
import { useDismissibleLayer } from './readerNavigation';
import { useAnnotations, type Annotation } from './readerState';
import { onPrivateDataCleared } from './data/session';
import { type QiqiContext, type QiqiMessage } from './qiqiChat';
import QiqiSettings from './QiqiSettings';
import { useQiqiChat } from './useQiqiChat';
import { useUpdateGuard } from './useUpdateGuard';
import './qiqi.css';

const QiqiAnswer = lazy(() => import('./QiqiAnswer'));
function ContextPreview({ context, remove }: { context: QiqiContext; remove?: () => void }) {
  return (
    <details className="qiqi-context">
      <summary>
        <span>
          {context.identity.path} · L{context.line}
          {context.note ? ' · 含批注' : ''}
        </span>
      </summary>
      <pre>{context.snippet}</pre>
      {context.note && (
        <p>
          <strong>我的批注</strong>
          <br />
          {context.note}
        </p>
      )}
      {context.truncated && <p>片段过长，已截取前面的内容。</p>}
      {remove && (
        <button type="button" onClick={remove}>
          移除引用
        </button>
      )}
    </details>
  );
}
function SaveReply({
  context,
  content,
  notify,
  close,
}: {
  context: QiqiContext;
  content: string;
  notify: (message: string) => void;
  close: () => void;
}) {
  const { annotations, persist, error } = useAnnotations(context.identity, notify);
  const [draft, setDraft] = useState(content);
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || draft.length > 10000) return;
    // Always create a new annotation. A reply from an older conversation cannot
    // overwrite an annotation edited or deleted in another reader or device.
    const item: Annotation = {
      id: crypto.randomUUID(),
      line: context.line,
      snippet: context.snippet.slice(0, 2000),
      note: draft.trim(),
      createdAt: Date.now(),
      localRev: 1,
      syncStatus: 'pending',
    };
    if (
      persist(
        [...annotations, item].sort((a, b) => a.line - b.line),
        { type: 'save', item },
      )
    ) {
      notify('已另存为本机批注，等待同步；原批注保留');
      close();
    }
  };
  return (
    <form className="qiqi-save" onSubmit={save}>
      <h3>另存为批注</h3>
      <ContextPreview context={context} />
      <p>确认后保存到本机批注，点击「同步」后上传。原文和原批注保留。</p>
      {context.snippet.length > 2000 && <p>批注引用保存这段内容的前 2000 字。</p>}
      <label>
        批注草稿
        <textarea
          aria-label="七七批注草稿"
          value={draft}
          rows={12}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <p>{draft.length} / 10000 字</p>
      {error && <p role="alert">{error}</p>}
      <div className="qiqi-actions">
        <button type="button" className="button secondary" onClick={close}>
          返回对话
        </button>
        <button
          className="button primary"
          disabled={!draft.trim() || draft.length > 10000 || !!error}
        >
          确认保存批注
        </button>
      </div>
    </form>
  );
}
export default function QiqiPanel({
  userId,
  notify,
}: {
  userId: string;
  notify: (message: string) => void;
}) {
  const chat = useQiqiChat(userId);
  const { config, conversations, current, running, error, storageError, setError } = chat;
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [input, setInput] = useState('');
  const [context, setContext] = useState<QiqiContext>();
  const [reply, setReply] = useState<{ context: QiqiContext; content: string }>();
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const inform = (message: string) => {
    setNotice(message);
    notify(message);
  };
  const validSession = useRef(true);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const close = () => {
    chat.stop();
    setOpen(false);
    setSettings(false);
    setReply(undefined);
    setConfirmDelete(undefined);
  };
  useDismissibleLayer(open, close);
  useEffect(() => {
    validSession.current = true;
    const cleanup = onPrivateDataCleared(() => {
      validSession.current = false;
      chat.stop();
      setOpen(false);
      setInput('');
      setContext(undefined);
      setReply(undefined);
    });
    return () => {
      validSession.current = false;
      chat.stop();
      cleanup();
    };
  }, [userId]);
  useEffect(() => {
    const attach = (event: Event) => {
      const value = (event as CustomEvent<QiqiContext>).detail;
      if (value?.identity.userId !== userId || !validSession.current) return;
      setContext(value);
      setSettings(false);
      setReply(undefined);
      setOpen(true);
      setError('');
    };
    const launch = () => {
      if (validSession.current) setOpen(true);
    };
    window.addEventListener('codesip:open-qiqi', launch);
    window.addEventListener('codesip:ask-qiqi', attach);
    return () => {
      window.removeEventListener('codesip:open-qiqi', launch);
      window.removeEventListener('codesip:ask-qiqi', attach);
    };
  }, [userId]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href]',
        ) || [],
      ).filter((element) => element.getClientRects().length);
      const first = focusable[0],
        last = focusable.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', key);
      previous?.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => {
    if (nearBottom.current && logRef.current)
      logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [current.messages, open, current.id, settings, reply]);
  useUpdateGuard(
    running
      ? '七七正在回答，请先停止生成'
      : input.trim()
        ? '七七的消息需发送或清空'
        : open && reply
          ? '请先保存或关闭七七批注草稿'
          : undefined,
  );
  useEffect(() => {
    const removed = (event: Event) => {
      const detail = (event as CustomEvent<{ userId: string; libraryId: string }>).detail;
      if (detail?.userId !== userId) return;
      chat.stop();
      setContext((value) => (value?.identity.libraryId === detail.libraryId ? undefined : value));
      setReply(undefined);
    };
    window.addEventListener('codesip:library-removed', removed);
    return () => window.removeEventListener('codesip:library-removed', removed);
  }, [userId]);
  const newChat = () => {
    if (!chat.newChat()) return;
    setSettings(false);
    setInput('');
    setContext(undefined);
    setError('');
    setReply(undefined);
    setNotice('');
    setConfirmDelete(undefined);
    nearBottom.current = true;
  };
  const generate = (history: QiqiMessage[]) => {
    try {
      if (!chat.generate(history)) return;
      setInput('');
      setContext(undefined);
      setNotice('');
      setConfirmDelete(undefined);
      nearBottom.current = true;
    } catch {
      setSettings(true);
      setError('请先完成 API 设置');
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!input.trim() || running) return;
    if (current.messages.length >= 80) {
      setError('这段对话已较长，请新建对话后继续');
      return;
    }
    void generate([
      ...current.messages,
      { id: crypto.randomUUID(), role: 'user', content: input.trim(), context },
    ]);
  };
  const retry = () => {
    const messages = current.messages.slice();
    if (messages.at(-1)?.role === 'assistant') messages.pop();
    if (messages.at(-1)?.role === 'user') void generate(messages);
  };
  const last = current.messages.at(-1);
  return (
    <>
      <button
        type="button"
        className="icon-button qiqi-launcher"
        aria-label="打开七七"
        title="七七 · 阅读助手"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <MessageCircle size={18} />
        <span>七七</span>
      </button>
      {open &&
        createPortal(
          <div className="qiqi-scrim" onClick={close}>
            <section
              ref={dialogRef}
              className="qiqi-panel"
              role="dialog"
              aria-modal="true"
              aria-label="七七"
              onClick={(event) => event.stopPropagation()}
            >
              <header className="qiqi-header">
                <div>
                  <strong>七七</strong>
                  <span>{running ? '正在回答…' : config.model || '阅读助手'}</span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="新建七七对话"
                  disabled={running}
                  onClick={newChat}
                >
                  <Plus size={18} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="七七 API 设置"
                  disabled={running}
                  onClick={() => {
                    setReply(undefined);
                    setSettings(!settings);
                  }}
                >
                  <Settings2 size={18} />
                </button>
                <button type="button" className="icon-button" aria-label="关闭七七" onClick={close}>
                  <X size={19} />
                </button>
              </header>
              {settings ? (
                <QiqiSettings
                  initial={config}
                  back={() => {
                    setSettings(false);
                    setError('');
                  }}
                  save={(value) => {
                    if (!chat.configure(value))
                      inform('当前页面已应用配置，但本机设置更新失败，之前保存的设置可能仍保留');
                    setSettings(false);
                    setError('');
                  }}
                />
              ) : reply ? (
                <SaveReply
                  context={reply.context}
                  content={reply.content}
                  notify={inform}
                  close={() => setReply(undefined)}
                />
              ) : (
                <>
                  <div className="qiqi-history">
                    <label>
                      对话
                      <select
                        aria-label="七七对话记录"
                        value={current.id}
                        disabled={running}
                        onChange={(event) => {
                          chat.selectChat(event.target.value);
                          setConfirmDelete(undefined);
                          setNotice('');
                          setInput('');
                          setContext(undefined);
                          setError('');
                          nearBottom.current = true;
                        }}
                      >
                        {conversations.map((value) => (
                          <option key={value.id} value={value.id}>
                            {value.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="删除当前七七对话"
                      disabled={running}
                      onClick={() => setConfirmDelete(current.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  {confirmDelete === current.id && (
                    <div className="qiqi-delete">
                      <span>删除这段本机对话？</span>
                      <button type="button" onClick={() => setConfirmDelete(undefined)}>
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (confirmDelete) chat.deleteChat(confirmDelete);
                          setInput('');
                          setContext(undefined);
                          setError('');
                          setConfirmDelete(undefined);
                        }}
                      >
                        确认删除对话
                      </button>
                    </div>
                  )}
                  <div
                    ref={logRef}
                    className="qiqi-log"
                    role="log"
                    aria-label="七七对话"
                    aria-live="polite"
                    aria-relevant="additions"
                    onScroll={() => {
                      const log = logRef.current!;
                      nearBottom.current = log.scrollHeight - log.clientHeight - log.scrollTop < 80;
                    }}
                  >
                    {!current.messages.length && (
                      <div className="qiqi-empty">
                        <MessageCircle size={30} />
                        <h3>一起读懂这一段</h3>
                        <p>直接聊天，或从选区、批注里点击「问七七」，把相关内容带到这里。</p>
                        <p>对话记录保存在此设备。</p>
                      </div>
                    )}
                    {current.messages.map((message) => (
                      <article key={message.id} className={`qiqi-message qiqi-${message.role}`}>
                        <strong>{message.role === 'user' ? '你' : '七七'}</strong>
                        {message.context && <ContextPreview context={message.context} />}
                        {message.role === 'user' ? (
                          <p className="qiqi-user-text">{message.content}</p>
                        ) : (
                          <div className="qiqi-answer">
                            <Suspense fallback={<p>{message.content || '正在思考…'}</p>}>
                              <QiqiAnswer
                                content={
                                  message.content ||
                                  (running && message === last ? '正在思考…' : '没有接收到文字')
                                }
                              />
                            </Suspense>
                          </div>
                        )}
                        {message.role === 'assistant' && (
                          <>
                            {message.status !== 'complete' && !(running && message === last) && (
                              <p className="qiqi-message-status">
                                {message.status === 'error' ? '回答未完成' : '已停止'}
                              </p>
                            )}
                            {!!message.content && (
                              <div className="qiqi-message-actions">
                                <button
                                  type="button"
                                  onClick={async () => {
                                    try {
                                      await navigator.clipboard.writeText(message.content);
                                      inform('已复制回答');
                                    } catch {
                                      inform('复制失败，可选择文字后复制');
                                    }
                                  }}
                                >
                                  <Copy size={13} />
                                  复制
                                </button>
                                {message.context && (
                                  <button
                                    type="button"
                                    disabled={running}
                                    onClick={() =>
                                      setReply({
                                        context: message.context!,
                                        content: message.content,
                                      })
                                    }
                                  >
                                    另存为批注
                                  </button>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </article>
                    ))}
                  </div>
                  <form className="qiqi-composer" onSubmit={submit}>
                    {notice && <p role="status">{notice}</p>}
                    {storageError && <p role="status">{storageError}</p>}
                    {error && <p role="alert">{error}</p>}
                    {!running && last?.role === 'assistant' && last.status !== 'complete' && (
                      <button type="button" className="qiqi-retry" onClick={retry}>
                        重试回答
                      </button>
                    )}
                    {context && (
                      <div className="qiqi-pending-context">
                        <ContextPreview context={context} remove={() => setContext(undefined)} />
                        <button
                          type="button"
                          aria-label="移除七七引用"
                          onClick={() => setContext(undefined)}
                        >
                          <X size={15} />
                        </button>
                      </div>
                    )}
                    {context && (
                      <div className="qiqi-prompts">
                        {['解释这段内容', '帮我改写并说明理由', '检查我的理解'].map((prompt) => (
                          <button
                            key={prompt}
                            type="button"
                            disabled={running}
                            onClick={() => {
                              setInput(prompt);
                              inputRef.current?.focus();
                            }}
                          >
                            {prompt}
                          </button>
                        ))}
                      </div>
                    )}
                    <textarea
                      ref={inputRef}
                      aria-label="给七七的消息"
                      placeholder="问问七七…"
                      rows={3}
                      maxLength={20000}
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          (event.ctrlKey || event.metaKey) &&
                          event.key === 'Enter' &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          submit(event);
                        }
                      }}
                    />
                    <div className="qiqi-send">
                      <span>{context ? '发送时包含上面的引用' : 'Ctrl / ⌘ + Enter 发送'}</span>
                      {running ? (
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => chat.stop()}
                        >
                          <Square size={14} />
                          停止生成
                        </button>
                      ) : (
                        <button className="button primary" disabled={!input.trim()}>
                          <Send size={14} />
                          发送
                        </button>
                      )}
                    </div>
                  </form>
                </>
              )}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
