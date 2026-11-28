import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Do not execute model HTML or fetch model-generated remote images. Responses
// are suggestions, displayed only inside the chat panel.
export default function QiqiAnswer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : '[图片]'}</span>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
