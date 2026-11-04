import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { AgentStatusBar } from './AgentStatusBar';
import type { AgentSessionStatus } from '../../shared/agentProtocol';

const status = (state: AgentSessionStatus['state']): AgentSessionStatus => ({
  sessionId: 'session-1',
  absolutePath: '/vault/note.md',
  state,
  documentVersion: 1,
  diskRevision: 'rev',
  pendingOperations: 0,
});
const render = (
  state: AgentSessionStatus['state'],
  onStop?: (id: string) => void,
) =>
  renderToStaticMarkup(
    createElement(AgentStatusBar, { status: status(state), onStop }),
  );

test('visible status bar identifies an unconnected agent', () => {
  const html = renderToStaticMarkup(
    createElement(AgentStatusBar, { visible: true }),
  );
  assert.match(html, />Agent</);
  assert.match(html, />Not connected</);
});

test('status bar retains every status while visible and never offers Stop unless writing', () => {
  const labels = {
    connected: 'Connected',
    writing: 'Writing',
    finished: 'Finished',
    cancelled: 'Stopped',
    disconnected: 'Disconnected',
    failed: 'Failed',
  } as const;
  for (const [state, label] of Object.entries(labels) as Array<
    [keyof typeof labels, (typeof labels)[keyof typeof labels]]
  >) {
    const html = render(state, () => {});
    assert.match(html, new RegExp(`>${label}</`));
    if (state === 'writing') assert.match(html, /aria-label="Stop agent"/);
    else assert.doesNotMatch(html, /aria-label="Stop agent"/);
  }
  assert.doesNotMatch(render('writing'), /aria-label="Stop agent"/);
  const thinking = renderToStaticMarkup(
    createElement(AgentStatusBar, {
      status: { ...status('connected'), activity: 'thinking' },
    }),
  );
  assert.match(thinking, />Thinking</);
  assert.match(thinking, /agent-status-spinner/);
  assert.doesNotMatch(render('connected'), /agent-status-spinner/);
  const drafting = renderToStaticMarkup(
    createElement(AgentStatusBar, {
      status: { ...status('connected'), activity: 'drafting' },
    }),
  );
  assert.match(drafting, />Drafting</);
  assert.match(drafting, /agent-status-spinner/);
});

test('manual visibility hides every status regardless of session state', () => {
  for (const state of [
    'writing',
    'finished',
    'cancelled',
    'disconnected',
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(AgentStatusBar, {
        status: status(state),
        onStop: () => {},
        visible: false,
      }),
    );
    assert.doesNotMatch(html, /data-testid="agent-status-bar"/);
  }
});

test('finished status reports Writing while the preview is still updating', () => {
  const html = renderToStaticMarkup(
    createElement(AgentStatusBar, {
      status: status('finished'),
      previewPending: true,
    }),
  );
  assert.match(html, />Writing</);
  assert.doesNotMatch(html, /Revealing/);
  assert.doesNotMatch(html, /Finished/);
  assert.doesNotMatch(html, /Stop/);
  assert.match(html, /agent-status-spinner/);
});

test('preview progress never masks cancellation, errors, or other session states', () => {
  for (const state of ['cancelled', 'failed', 'disconnected'] as const) {
    const html = renderToStaticMarkup(
      createElement(AgentStatusBar, {
        status: status(state),
        previewPending: true,
      }),
    );
    assert.doesNotMatch(html, />Writing</);
  }
});
