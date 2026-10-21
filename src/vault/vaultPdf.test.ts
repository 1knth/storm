import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readVaultPdf } from './vaultAssets';

test('reads PDF bytes only for valid regular files within the vault', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'storm-pdf-'));
  try {
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'file.pdf'), '%PDF-1.7 test');
    assert.equal(
      Buffer.from(await readVaultPdf(root, 'docs/file.pdf')).toString(),
      '%PDF-1.7 test',
    );
    await assert.rejects(readVaultPdf(root, '../outside.pdf'));
    await assert.rejects(readVaultPdf(root, 'docs/file.txt'), /Unsupported/);
    await assert.rejects(readVaultPdf(root, 'docs/file.pdf/child'));
    await writeFile(path.join(root, 'docs', 'bad.pdf'), 'not a PDF');
    await assert.rejects(readVaultPdf(root, 'docs/bad.pdf'), /Invalid PDF/);
    const outside = path.join(os.tmpdir(), `storm-outside-${process.pid}.pdf`);
    await writeFile(outside, '%PDF-1.7 outside');
    await symlink(outside, path.join(root, 'docs', 'linked.pdf'));
    await assert.rejects(readVaultPdf(root, 'docs/linked.pdf'));
    await rm(outside, { force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
