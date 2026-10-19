import { useEffect, useId, useState } from 'react';
import DOMPurify, { type Config } from 'dompurify';
import mermaid from 'mermaid';
import { sanitizeSvgReferences } from './svgReferences';
import type { Appearance } from '../../appearance';
import { mermaidThemeVariables } from '../../appearance';

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

type Props = { source: string; appearance: Appearance };

export default function MermaidBlock({ source, appearance }: Props) {
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
      // Mermaid serializes render calls internally; initialize immediately before each
      // queued render so each diagram gets its own palette without concurrent races.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        maxTextSize: MAX_SOURCE_LENGTH,
        suppressErrorRendering: true,
        flowchart: { htmlLabels: false },
        theme: 'base',
        themeVariables: mermaidThemeVariables(appearance),
        secure: ['securityLevel', 'startOnLoad', 'theme', 'themeVariables'],
      });
      const safeSource = source.replace(/^%%\{[\s\S]*?\}%%\s*/gm, '');
      void mermaid
        .render(id, safeSource)
        .then(({ svg: renderedSvg }) => {
          if (cancelled) return;
          // Mermaid's generated stylesheet can override palette values for cluster
          // geometry in some diagram variants. Apply validated preferences directly
          // to cluster SVG elements before sanitizing the rendered markup.
          const parsedSvg = new DOMParser().parseFromString(
            renderedSvg,
            'image/svg+xml',
          );
          const groupFill = mermaidThemeVariables(appearance).clusterBkg;
          const groupBorder = mermaidThemeVariables(appearance).clusterBorder;
          parsedSvg
            .querySelectorAll('.cluster rect, .flow-cluster rect')
            .forEach((rect) => {
              rect.setAttribute(
                'style',
                `fill: ${groupFill} !important; stroke: ${groupBorder} !important`,
              );
            });
          const groupText = mermaidThemeVariables(appearance).titleColor;
          parsedSvg.querySelectorAll('.cluster-label text').forEach((text) => {
            text.setAttribute('style', `fill: ${groupText} !important`);
          });
          const purifiedSvg = String(
            DOMPurify.sanitize(
              parsedSvg.documentElement.outerHTML,
              svgSanitizerOptions,
            ),
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
  }, [id, source, appearance]);

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
