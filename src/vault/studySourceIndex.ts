import { createHash } from 'node:crypto';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { STUDY_LIMITS, type StudyChunk } from '../shared/studyContext';

export const studyHash = (text: string) =>
  createHash('sha256').update(text).digest('hex');

/** Parse structure without treating source text as agent instructions. */
export function indexStudySource(sourceId: string, text: string) {
  const headings: Array<{ from: number; title: string }> = [];
  const hidden: Array<[number, number]> = [];
  markdownLanguage.parser.parse(text).iterate({
    enter(node) {
      if (/^(ATX|Setext)Heading\d$/.test(node.name)) {
        const title = text
          .slice(node.from, node.to)
          .split('\n')[0]
          .replace(/^#+\s*/, '')
          .replace(/\s+#+$/, '')
          .trim()
          .slice(0, 256);
        headings.push({ from: node.from, title });
      }
      if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name))
        hidden.push([node.from, node.to]);
    },
  });
  const links = [
    ...text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g),
  ]
    .filter((m) => !hidden.some(([a, b]) => m.index >= a && m.index < b))
    .slice(0, 100)
    .map((m) => m[1].trim());
  const hash = studyHash(text);
  const boundaries = [
    ...new Set([0, ...headings.map((h) => h.from), text.length]),
  ].sort((a, b) => a - b);
  const chunks: StudyChunk[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const begin = boundaries[i],
      end = boundaries[i + 1];
    const heading = headings.findLast((h) => h.from <= begin)?.title ?? '';
    let from = begin;
    while (from < end) {
      let to = Math.min(end, from + STUDY_LIMITS.chunkBytes);
      while (Buffer.byteLength(text.slice(from, to)) > STUDY_LIMITS.chunkBytes)
        to -= Math.max(1, Math.floor((to - from) / 8));
      if (to < end) {
        const newline = text.lastIndexOf('\n', to - 1);
        if (newline > from) to = newline + 1;
        if (to > from && /[\uD800-\uDBFF]/.test(text[to - 1])) to--;
      }
      const body = text.slice(from, to);
      chunks.push({
        id: studyHash(`${sourceId}:${hash}:${from}:${to}`),
        sourceId,
        contentHash: hash,
        heading,
        startLine: text.slice(0, from).split('\n').length,
        endLine: text.slice(0, to).split('\n').length,
        startOffset: from,
        endOffset: to,
        completeness: from === begin && to === end ? 'section' : 'continuation',
        text: body,
      });
      from = to;
    }
  }
  return { chunks, links };
}
