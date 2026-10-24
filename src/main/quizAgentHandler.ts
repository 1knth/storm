import type {
  AgentRequest,
  AgentResponse,
  AgentQuizSession,
  AgentQuizSnapshot,
} from '../shared/agentProtocol';
import type { QuizService } from './quizService';

const publicSession = (
  session: import('../shared/quizProtocol').QuizSession,
): AgentQuizSession => {
  const { agentToken: _token, ...value } = session;
  return value;
};
const publicSnapshot = (
  snapshot: import('../shared/quizProtocol').QuizSnapshot,
): AgentQuizSnapshot => ({
  session: publicSession(snapshot.session),
  events: snapshot.events,
});

export function createQuizAgentHandler(
  service: Pick<
    QuizService,
    | 'listSessions'
    | 'attachSession'
    | 'disconnectAgent'
    | 'setAgentActivity'
    | 'getSnapshot'
    | 'request'
    | 'getImageForAgent'
    | 'releaseImageForAgent'
  >,
) {
  return async (
    request: Extract<AgentRequest, { type: 'quiz' }>,
  ): Promise<AgentResponse> => {
    const base = {
      protocol: 1 as const,
      requestId: request.requestId,
      ok: true as const,
      type: 'quiz' as const,
    };
    switch (request.operation) {
      case 'list':
        return {
          ...base,
          operation: 'list',
          result: {
            ok: true,
            // The agent broker is a machine interface: include unsaved draft sessions
            // so a newly created session can be attached before GUI history refreshes.
            value: (await service.listSessions({ includeDrafts: true })).map(
              publicSession,
            ),
          },
        };
      case 'attach': {
        const result = await service.attachSession(request.sessionId);
        return {
          ...base,
          operation: 'attach',
          result: result.ok
            ? {
                ok: true,
                value: {
                  agentToken: result.value.agentToken,
                  snapshot: publicSnapshot(result.value.snapshot),
                },
              }
            : { ok: false, error: result.error },
        };
      }
      case 'detach': {
        const result = await service.disconnectAgent(
          request.sessionId,
          request.agentToken,
        );
        return {
          ...base,
          operation: 'detach',
          result: result.ok
            ? { ok: true, value: publicSession(result.value) }
            : result,
        };
      }
      case 'activity': {
        const result = await service.setAgentActivity(
          request.sessionId,
          request.agentToken,
          request.state,
        );
        return {
          ...base,
          operation: 'activity',
          result: result.ok
            ? { ok: true, value: publicSession(result.value) }
            : result,
        };
      }
      case 'image-fetch': {
        const image = await service.getImageForAgent(
          request.sessionId,
          request.agentToken,
          request.imageId,
        );
        return {
          ...base,
          operation: 'image-fetch',
          result: image.ok
            ? {
                ok: true,
                value: {
                  id: image.value.metadata.id,
                  mimeType: image.value.metadata.mimeType,
                  size: image.value.metadata.size,
                  path: image.value.path,
                },
              }
            : image,
        };
      }
      case 'image-release': {
        const result = await service.releaseImageForAgent(
          request.sessionId,
          request.agentToken,
          request.imageId,
        );
        return { ...base, operation: 'image-release', result };
      }
      case 'snapshot': {
        const snapshot = await service.getSnapshot(
          request.sessionId,
          request.after ?? 0,
        );
        if (!snapshot)
          return { ...base, operation: 'snapshot', snapshot: null };
        if (snapshot.session.agentToken !== request.agentToken)
          return {
            protocol: 1,
            requestId: request.requestId,
            ok: false,
            error: {
              code: 'INVALID_REQUEST',
              message: 'Quiz agent token is invalid',
              retryable: false,
            },
          };
        return {
          ...base,
          operation: 'snapshot',
          snapshot: publicSnapshot(snapshot),
        };
      }
      case 'request': {
        const result = await service.request(request.request);
        return {
          ...base,
          operation: 'request',
          result: result.ok
            ? { ok: true, value: publicSession(result.value) }
            : result,
        };
      }
    }
  };
}
