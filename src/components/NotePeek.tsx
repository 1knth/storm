import ReactMarkdown from 'react-markdown';

type NotePeekProps = { markdown: string };

export default function NotePeek({ markdown }: NotePeekProps) {
  if (!markdown.trim()) return <>...</>;

  return (
    <ReactMarkdown
      allowedElements={['p', 'em', 'strong', 'del', 'code', 'a', 'br']}
      unwrapDisallowed
      components={{
        p: ({ children }) => <span>{children}</span>,
        a: ({ children }) => <span>{children}</span>,
        br: () => <span> </span>,
        code: ({ children }) => (
          <code className="rounded bg-white/10 px-0.5 font-mono not-italic">
            {children}
          </code>
        ),
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
