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

test('visible status bar retains Agent label without a decorative icon', () => {
  const html = renderToStaticMarkup(
    createElement(AgentStatusBar, { visible: true }),
  );
  assert.match(html, />Agent</);
  assert.match(html, />Not connected</);
  assert.doesNotMatch(html, /<svg\b/);
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
    assert.match(html, /h-\[22px\]/);
    assert.match(html, new RegExp(`>${label}</`));
    if (state === 'writing') assert.match(html, /aria-label="Stop agent"/);
    else assert.doesNotMatch(html, /aria-label="Stop agent"/);
  }
  assert.match(render('connected'), />Connected</);
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

test('finished backend status remains Writing until preview reveal drains', () => {
  const html = renderToStaticMarkup(
    createElement(AgentStatusBar, {
      status: status('finished'),
      visualStatus: 'Writing',
    }),
  );
  assert.match(html, />Writing</);
  assert.doesNotMatch(html, /Finished/);
  assert.doesNotMatch(html, /Revealing/);
  assert.doesNotMatch(html, /Stop/);
});

test('Stop appears only while writing and finished has the brief label', () => {
  assert.match(
    render('writing', () => {}),
    /aria-label="Stop agent"/,
  );
  assert.doesNotMatch(render('writing'), /aria-label="Stop agent"/);
  assert.match(render('finished'), />Finished</);
});
