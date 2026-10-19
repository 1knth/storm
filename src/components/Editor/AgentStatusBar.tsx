import { FiStopCircle } from 'react-icons/fi';
import type { AgentSessionStatus } from '../../shared/agentProtocol';

export type AgentStatusBarProps = {
  status?: AgentSessionStatus;
  onStop?: (sessionId: string) => void;
  visible?: boolean;
};

export function AgentStatusBar({
  status,
  onStop,
  visible = true,
}: AgentStatusBarProps) {
  const label =
    status?.state === 'writing'
      ? 'Writing'
      : status?.state === 'connected'
        ? 'Connected'
        : status?.state === 'finished'
          ? 'Finished'
          : status?.state === 'cancelled'
            ? 'Stopped'
            : status?.state === 'disconnected'
              ? 'Disconnected'
              : status?.state === 'failed'
                ? 'Failed'
                : null;
  if (!visible) return null;
  return (
    <div
      className="flex h-[22px] shrink-0 items-center gap-2 border-t border-white/10 bg-white/[0.035] px-2 text-[11px] text-white/65"
      data-testid="agent-status-bar"
    >
      <span>{status?.name?.trim() || 'Agent'}</span>
      <span aria-hidden="true">·</span>
      <span>{label ?? 'Not connected'}</span>
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
