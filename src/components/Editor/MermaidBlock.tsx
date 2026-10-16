import { useEffect, useId, useState } from 'react';
import DOMPurify, { type Config } from 'dompurify';
import mermaid from 'mermaid';
import { sanitizeSvgReferences } from './svgReferences';

const MAX_SOURCE_LENGTH = 10_000;

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
  maxTextSize: MAX_SOURCE_LENGTH,
  suppressErrorRendering: true,
  flowchart: { htmlLabels: false },
});

const svgSanitizerOptions: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: [
    'a',
    'animate',
    'animateMotion',
    'animateTransform',
    'foreignObject',
    'image',
    'mpath',
    'script',
  ],
  FORBID_ATTR: ['href', 'xlink:href', 'src'],
};

type Props = { source: string };

export default function MermaidBlock({ source }: Props) {
  const reactId = useId();
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const id = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  useEffect(() => {
    let cancelled = false;
    setSvg('');
    setError('');

    if (source.length > MAX_SOURCE_LENGTH) {
      setError(
        `Diagram is too large (maximum ${MAX_SOURCE_LENGTH} characters).`,
      );
      return () => {
        cancelled = true;
      };
    }

    const timer = setTimeout(() => {
      void mermaid
        .render(id, source)
        .then(({ svg: renderedSvg }) => {
          if (cancelled) return;
          const purifiedSvg = String(
            DOMPurify.sanitize(renderedSvg, svgSanitizerOptions),
          );
          const cleanSvg = sanitizeSvgReferences(purifiedSvg);
          setSvg(cleanSvg);
        })
        .catch((renderError: unknown) => {
          if (!cancelled) {
            setError(
              renderError instanceof Error
                ? renderError.message
                : 'Unable to render diagram.',
            );
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, source]);

  if (error)
    return (
      <p className="my-3 rounded bg-white/5 p-3 text-xs text-rose-300">
        Diagram error: {error}
      </p>
    );
  if (!svg)
    return (
      <div
        className="my-3 min-h-8"
        role="status"
        aria-label="Rendering diagram"
      />
    );

  return (
    <div
      className="my-4 overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      aria-label="Mermaid diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
