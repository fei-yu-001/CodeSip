import type { useLibrarySync } from './useLibrarySync';
import type { SyncStage } from './sync/librarySync';
import './library-sync.css';
const stages: Record<SyncStage, string> = {
  manifest: '目录',
  annotations: '批注',
  documents: '编辑版',
  'reader-state': '远端修改',
  files: '文件',
};
export default function LibrarySyncStatus({
  sync,
  blocked,
}: {
  sync: ReturnType<typeof useLibrarySync>;
  blocked: boolean;
}) {
  if (sync.running)
    return (
      <section className="library-sync-status" aria-label="同步状态">
        <span role="status">{sync.progress || '正在连接…'}</span>
        <button type="button" onClick={sync.cancel}>
          取消同步
        </button>
      </section>
    );
  const failures = sync.result?.failures || [];
  if (!sync.error && !failures.length) return null;
  const projects = new Set(failures.map((failure) => failure.libraryId)).size;
  return (
    <section className="library-sync-status" aria-label="同步结果">
      <div>
        <p role="status">{sync.error || `${projects} 个项目尚未同步完成，已有本机内容保留`}</p>
        {!!failures.length && (
          <details>
            <summary>查看未完成项目</summary>
            <ul>
              {failures.map((failure, index) => (
                <li key={`${failure.libraryId}:${failure.stage}:${index}`}>
                  {failure.libraryName} · {stages[failure.stage]}：{failure.message}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <button type="button" disabled={blocked} onClick={() => void sync.retry()}>
        重试未完成项目
      </button>
      <button type="button" aria-label="收起同步结果" onClick={sync.dismiss}>
        收起
      </button>
    </section>
  );
}
