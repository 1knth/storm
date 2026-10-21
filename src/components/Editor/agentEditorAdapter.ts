import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { AgentRevealMetadata } from '../../documents/agentDocumentController';

/** Owner-provided document binding. Identity uses vault identity plus vault-relative path. */
export type AgentEditorAdapter = {
  vaultId: string;
  path: string;
  writing: boolean;
  /** Accepted agent source ranges, versioned independently from React status transitions. */
  reveal?: AgentRevealMetadata;
  onStateChange: (state: EditorState) => void;
  flush: () => Promise<boolean>;
  /** Optional owner revision; informational and does not replace editor state. */
  revision?: string;
};

export function agentWritingLockExtensions(writing: boolean): Extension {
  return writing
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [];
}

export function shouldBlockAgentEditorMouseDown(writing: boolean): boolean {
  return writing;
}

export function matchesAgentEditor(
  adapter: AgentEditorAdapter | undefined,
  vaultId: string,
  path: string,
): boolean {
  return Boolean(
    adapter && adapter.vaultId === vaultId && adapter.path === path,
  );
}
