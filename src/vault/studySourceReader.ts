import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { STUDY_LIMITS, isStudyPath } from '../shared/studyContext';

/** Bounded direct read; callers supply the application's capture coordination. */
export async function readStudySource(
  root: string,
  relative: string,
): Promise<string> {
  if (!isStudyPath(relative) || !relative.toLowerCase().endsWith('.md'))
    throw new Error('STUDY_INVALID_PATH');
  const canonical = await realpath(root);
  if (canonical !== root) throw new Error('STUDY_ROOT_CHANGED');
  let target = root;
  for (const segment of relative.split('/')) {
    target = path.join(target, segment);
    if ((await lstat(target)).isSymbolicLink())
      throw new Error('STUDY_INVALID_PATH');
  }
  if ((await realpath(target)) !== target)
    throw new Error('STUDY_INVALID_PATH');
  const file = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > STUDY_LIMITS.sourceBytes)
      throw new Error('STUDY_SOURCE_TOO_LARGE');
    const buffer = Buffer.alloc(STUDY_LIMITS.sourceBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    if (length > STUDY_LIMITS.sourceBytes)
      throw new Error('STUDY_SOURCE_TOO_LARGE');
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('STUDY_SOURCE_BUSY');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, length),
    );
  } finally {
    await file.close();
  }
}
