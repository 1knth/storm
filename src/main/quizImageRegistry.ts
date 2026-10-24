import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const MAX_QUIZ_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_QUIZ_MESSAGE_IMAGES = 4;
export type QuizImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
export type QuizImageMetadata = {
  id: string;
  mimeType: QuizImageMimeType;
  size: number;
};
export type QuizImageInput = { mimeType: string; data: Uint8Array };
function detectMimeType(data: Uint8Array): QuizImageMimeType | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    String.fromCharCode(...data.subarray(1, 4)) === 'PNG' &&
    data[4] === 13 &&
    data[5] === 10 &&
    data[6] === 0x1a &&
    data[7] === 10
  )
    return 'image/png';
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return 'image/jpeg';
  if (
    data.length >= 12 &&
    String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...data.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** Owns only UUID-named files in its private directory; paths never enter quiz metadata. */
export class QuizImageRegistry {
  private readonly images = new Map<
    string,
    {
      sessionId: string;
      metadata: QuizImageMetadata;
      path: string;
      expires: number;
    }
  >();
  private readonly root: string;
  constructor(
    root = join(tmpdir(), `storm-quiz-images-${randomUUID()}`),
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly now = Date.now,
  ) {
    this.root = root;
  }
  private ensureRoot() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
  }
  private removeId(id: string) {
    const image = this.images.get(id);
    if (!image) return false;
    this.images.delete(id);
    try {
      unlinkSync(image.path);
    } catch {
      /* already absent */
    }
    return true;
  }
  private prune() {
    for (const [id, image] of this.images)
      if (image.expires <= this.now()) this.removeId(id);
  }
  add(sessionId: string, input: QuizImageInput): QuizImageMetadata | null {
    this.prune();
    if (
      !sessionId ||
      !(input?.data instanceof Uint8Array) ||
      input.data.byteLength === 0 ||
      input.data.byteLength > MAX_QUIZ_IMAGE_BYTES
    )
      return null;
    const data = Buffer.from(input.data);
    const mimeType = detectMimeType(data);
    if (!mimeType || input.mimeType !== mimeType) return null;
    this.ensureRoot();
    const metadata = { id: randomUUID(), mimeType, size: data.byteLength };
    const path = join(this.root, `${metadata.id}.image`);
    try {
      writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
      chmodSync(path, 0o600);
    } catch {
      return null;
    }
    this.images.set(metadata.id, {
      sessionId,
      metadata,
      path,
      expires: this.now() + this.ttlMs,
    });
    return metadata;
  }
  remove(sessionId: string, id: string): boolean {
    const image = this.images.get(id);
    return !!image && image.sessionId === sessionId && this.removeId(id);
  }
  get(
    sessionId: string,
    id: string,
  ): { metadata: QuizImageMetadata; path: string } | null {
    this.prune();
    const image = this.images.get(id);
    return image?.sessionId === sessionId
      ? { metadata: image.metadata, path: image.path }
      : null;
  }
  count(sessionId: string): number {
    this.prune();
    let count = 0;
    for (const image of this.images.values())
      if (image.sessionId === sessionId) count++;
    return count;
  }
  purgeSession(sessionId: string): void {
    for (const [id, image] of this.images)
      if (image.sessionId === sessionId) this.removeId(id);
  }
  dispose(): void {
    for (const id of this.images.keys()) this.removeId(id);
  }
}
