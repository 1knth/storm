import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import path from 'node:path';

export interface RenameLinkDocument {
  path: string;
  content: string;
}
export interface RenameLinkPlan {
  path: string;
  content: string;
  updates: number;
}

const parser = unified().use(remarkParse).use(remarkGfm);
const norm = (value: string) => value.replace(/\\/g, '/').replace(/^\/+/, '');

/** Pure link-rewrite preview. Paths are vault-relative POSIX paths; no I/O is performed. */
export function planRenameLinks(
  documents: RenameLinkDocument[],
  oldPath: string,
  newPath: string,
): RenameLinkPlan[] {
  oldPath = norm(oldPath);
  newPath = norm(newPath);
  const files = documents.map((doc) => doc.path);
  const moved = (path: string) =>
    path === oldPath || path.startsWith(`${oldPath}/`);
  const destination = (path: string) =>
    moved(path) ? newPath + path.slice(oldPath.length) : path;
  const resolve = (source: string, target: string): string | undefined => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(target)
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
    } catch {
      return;
    }
    if (!decoded || /^(?:[a-z]+:|#|\/\/)/i.test(target)) return;
    const withExt = /\.md$/i.test(decoded) ? decoded : `${decoded}.md`;
    const dir = source.includes('/')
      ? source.slice(0, source.lastIndexOf('/'))
      : '';
    const candidates = [
      path.posix.normalize(path.posix.join(dir, withExt)),
      path.posix.normalize(withExt),
    ];
    for (const candidate of candidates) {
      if (
        candidate === '..' ||
        candidate.startsWith('../') ||
        candidate.startsWith('/')
      )
        continue;
      const found = files.filter(
        (file) => file.toLowerCase() === candidate.toLowerCase(),
      );
      if (found.length) return found.length === 1 ? found[0] : undefined;
    }
    if (!withExt.includes('/')) {
      const found = files.filter(
        (file) =>
          file.split('/').at(-1)?.toLowerCase() === withExt.toLowerCase(),
      );
      if (found.length === 1) return found[0];
    }
  };
  return documents.map(({ path: source, content }) => {
    const edits: { start: number; end: number; value: string }[] = [];
    const tree = parser.parse(content);
    const visit = (node: any) => {
      if (node.type === 'link' || node.type === 'image') {
        const url: string = node.url;
        const target = url.split(/[?#]/, 1)[0];
        const resolved = resolve(source, target);
        if (resolved && moved(resolved)) {
          const span = content.slice(
            node.position.start.offset,
            node.position.end.offset,
          );
          const raw = span.indexOf(url);
          if (raw >= 0 && !/^(?:[a-z]+:|\/\/)/i.test(url)) {
            const movedSource = destination(source);
            const movedTarget = destination(resolved);
            const relative = movedSource.slice(
              0,
              movedSource.lastIndexOf('/') + 1,
            );
            const targetPath = movedTarget.startsWith(relative)
              ? movedTarget.slice(relative.length)
              : movedTarget;
            let replacement = /\.md$/i.test(target)
              ? targetPath
              : targetPath.replace(/\.md$/i, '');
            try {
              replacement = encodeURI(decodeURIComponent(replacement))
                .replace(/#/g, '%23')
                .replace(/\?/g, '%3F');
            } catch {
              /* retain encoded input convention */
            }
            edits.push({
              start: node.position.start.offset + raw,
              end: node.position.start.offset + raw + url.length,
              value: replacement + url.slice(target.length),
            });
          }
        }
      }
      if (node.type === 'text' && node.position) {
        const start = node.position.start.offset,
          text = content.slice(start, node.position.end.offset);
        for (const match of text.matchAll(
          /\[\[([^\]|#?]+)([?#][^\]|]*)?(\|[^\]]*)?\]\]/g,
        )) {
          const target = match[1];
          const resolved = resolve(source, target);
          if (!resolved || !moved(resolved)) continue;
          const movedSource = destination(source),
            movedTarget = destination(resolved);
          const dir = movedSource.includes('/')
            ? movedSource.slice(0, movedSource.lastIndexOf('/') + 1)
            : '';
          const relative = movedTarget.startsWith(dir)
            ? movedTarget.slice(dir.length)
            : movedTarget;
          const replacement = relative.replace(/\.md$/i, '');
          const at = start + match.index! + 2;
          edits.push({
            start: at,
            end: at + target.length,
            value: replacement,
          });
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    edits.sort((a, b) => b.start - a.start);
    let output = content;
    for (const edit of edits)
      output =
        output.slice(0, edit.start) + edit.value + output.slice(edit.end);
    return {
      path: destination(source),
      content: output,
      updates: edits.length,
    };
  });
}
