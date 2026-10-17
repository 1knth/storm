import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { vaultImageErrorMessage } from './vaultImageError';

test('maps known image failures to actionable safe messages', () => {
  assert.equal(
    vaultImageErrorMessage(new Error('Image not found')),
    'Image not found in this vault.',
  );
  assert.equal(
    vaultImageErrorMessage(new Error('Error: Ambiguous image path')),
    'Multiple matching images found in this vault.',
  );
  assert.equal(
    vaultImageErrorMessage(
      new Error(
        'Unsupported image type (SVG and other formats are not supported)',
      ),
    ),
    'Image is unreadable or uses an unsupported format.',
  );
  assert.equal(
    vaultImageErrorMessage(
      new Error('Image content does not match its file type'),
    ),
    'Image is unreadable or uses an unsupported format.',
  );
  assert.equal(
    vaultImageErrorMessage(new Error('Image path is outside the vault')),
    'Image must be stored inside this vault.',
  );
  assert.equal(
    vaultImageErrorMessage(new Error('Unknown vault')),
    'The image’s vault is unavailable. Reopen the note from an available vault.',
  );
  assert.equal(
    vaultImageErrorMessage(new Error('Invalid note path')),
    'Image could not be loaded because its note context is unavailable.',
  );
});

test('does not expose paths or arbitrary IPC error details', () => {
  const message = vaultImageErrorMessage(
    new Error('EACCES: permission denied, open /Users/private/secret.png'),
  );
  assert.equal(message, 'Image is unreadable or uses an unsupported format.');
  assert.equal(message.includes('/Users/private'), false);
});
