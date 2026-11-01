import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyContextService } from '../src/main/studyContextService';
import { StudyContextStore } from '../src/main/studyContextStore';
import { VaultService } from '../src/vault/vaultService';
import { readStudySource } from '../src/vault/studySourceReader';
import { AgentBroker } from '../src/main/agentBroker';
import { startAgentEndpoint } from '../src/main/agentEndpoint';
import { runCli } from './storm';

test('study CLI round-trips scoped Unicode JSON, snapshots and validation through the authenticated broker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'storm-study-cli-'));
  await mkdir(join(dir, 'vault'));
  const root = await realpath(join(dir, 'vault'));
  await writeFile(join(root, 'Café.md'), '# Café\nCafé λ🧠 speed.\n');
  const service = new StudyContextService(
    new StudyContextStore(join(dir, 'study.json')),
    {
      vaults: async () => [{ id: 'vault', path: root }],
      entries: async () => {
        const vault = new VaultService();
        await vault.selectVault(root);
        return vault.listNotes({ previews: false });
      },
      live: async () => null,
      capture: async (_root, operation) => operation(),
      read: readStudySource,
    },
  );
  const endpoint = await startAgentEndpoint({
    userDataPath: dir,
    broker: new AgentBroker({
      resolveTarget: async () => {
        throw new Error('Study must not connect');
      },
      renderer: {
        dispatch: async () => {
          throw new Error('Study must not write');
        },
      },
      study: (request) => service.execute(request),
    }),
  });
  async function cli(value: unknown) {
    let output = '',
      error = '';
    const encoded = Buffer.from(JSON.stringify(value));
    const code = await runCli(
      ['--endpoint', endpoint.metadataPath, 'study', '--stdin'],
      {
        stdin: (async function* () {
          for (const byte of encoded) yield Buffer.from([byte]);
        })(),
        stdout: (t) => {
          output += t;
        },
        stderr: (t) => {
          error += t;
        },
      },
    );
    assert.equal(code, 0, error);
    return JSON.parse(output).result.value;
  }
  try {
    const opened = await cli({
      action: 'open',
      scope: {
        vaultId: 'vault',
        notePath: 'Café.md',
        folderPath: null,
        selectedNotePaths: [],
      },
    });
    const packet = await cli({
      action: 'retrieve',
      studyId: opened.studyId,
      query: 'Café',
    });
    assert.match(packet.chunks[0].text, /λ🧠/);
    const oldId = packet.snapshotId;
    await writeFile(join(root, 'Café.md'), '# Café\nChanged.\n');
    const validation = await cli({
      action: 'validate',
      studyId: opened.studyId,
      snapshotId: oldId,
    });
    assert.equal(validation.sources[0].state, 'changed');
    const pinned = await cli({
      action: 'read',
      studyId: opened.studyId,
      snapshotId: oldId,
    });
    assert.equal(pinned.chunks[0].text, packet.chunks[0].text);
  } finally {
    await endpoint.close();
    await rm(dir, { recursive: true, force: true });
  }
});
