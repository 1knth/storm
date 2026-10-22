import { FiStopCircle } from 'react-icons/fi';
import type { AgentSessionStatus } from '../../shared/agentProtocol';

export function agentStatusPresentation(
  status?: AgentSessionStatus,
  previewPending = false,
): { label: string; busy: boolean } {
  if (!status) return { label: 'Not connected', busy: false };
  if (status.state === 'failed') return { label: 'Failed', busy: false };
  if (status.state === 'cancelled') return { label: 'Stopped', busy: false };
  if (status.state === 'disconnected')
    return { label: 'Disconnected', busy: false };
  if (status.state === 'finished')
    return previewPending
      ? { label: 'Writing', busy: true }
      : { label: 'Finished', busy: false };
  if (status.state === 'writing') return { label: 'Writing', busy: true };
  if (status.activity === 'thinking') return { label: 'Thinking', busy: true };
  if (status.activity === 'drafting') return { label: 'Drafting', busy: true };
  return { label: 'Connected', busy: false };
}

export type AgentStatusBarProps = {
  status?: AgentSessionStatus;
  onStop?: (sessionId: string) => void;
  visible?: boolean;
  previewPending?: boolean;
};

export function AgentStatusBar({
  status,
  onStop,
  visible = true,
  previewPending = false,
}: AgentStatusBarProps) {
  const presentation = agentStatusPresentation(status, previewPending);
  const displayedLabel = presentation.label;
  const dotColor =
    displayedLabel === 'Connected'
      ? 'bg-green-400'
      : displayedLabel === 'Finished'
        ? 'bg-gray-400'
        : null;
  if (!visible) return null;
  return (
    <div
      className="flex h-[22px] shrink-0 items-center gap-2 border-y border-white/10 bg-white/[0.035] px-2 text-[11px] text-white/65"
      data-testid="agent-status-bar"
    >
      <span>{status?.name?.trim() || 'Agent'}</span>
      <span aria-hidden="true">|</span>
      {presentation.busy ? (
        <span
          aria-hidden="true"
          data-testid="agent-status-spinner"
          className="size-2 animate-spin rounded-full border border-white/25 border-t-blue-400"
        />
      ) : (
        dotColor && (
          <span
            aria-hidden="true"
            data-testid="agent-status-dot"
            className={`size-2 rounded-full ${dotColor}`}
          />
        )
      )}
      <span>{displayedLabel}</span>
      {status?.state === 'writing' && onStop && (
        <button
          type="button"
          onClick={() => onStop(status.sessionId)}
          className="ml-auto inline-flex items-center gap-1 text-red-400 hover:text-red-300"
          aria-label="Stop agent"
        >
          <FiStopCircle size={12} aria-hidden="true" />
          Stop
        </button>
      )}
    </div>
  );
}
