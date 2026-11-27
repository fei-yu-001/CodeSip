import { ArrowRight, BookOpen, FolderOpen, Trash2 } from 'lucide-react';
import type { Library } from '../../shared/types';
import { formatBytes, relativeDate } from './api';

export default function LibraryCard({
  library,
  index,
  open,
  remove,
  disabled,
}: {
  library: Library;
  index: number;
  open: () => void;
  remove: () => void;
  disabled: boolean;
}) {
  return (
    <div className="library-card-shell">
      <button className="library-card" onClick={open}>
        <div className="card-top">
          <div className={`project-icon shade-${index % 3}`}>
            {library.kind === 'code' ? <FolderOpen size={24} /> : <BookOpen size={23} />}
          </div>
          <ArrowRight size={19} />
        </div>
        <h3>{library.name}</h3>
        <p>
          {library.fileCount} 个文件 · {formatBytes(library.totalBytes)}
        </p>
        <div className="card-divider" />
        <div className="card-footer">
          <span>{relativeDate(library.updatedAt)}</span>
        </div>
      </button>
      <button
        className="icon-button library-card-delete"
        aria-label={`删除项目 ${library.name}`}
        title="删除项目"
        disabled={disabled}
        onClick={remove}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
