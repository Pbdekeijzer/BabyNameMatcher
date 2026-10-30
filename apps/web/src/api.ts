import type {
  ApiErrorBody,
  BootstrapPayload,
  CreateRoomResponse,
  JoinRoomResponse,
  RecoverRoomResponse,
  SyncOperation,
  SyncResponse,
} from '@baby-name-matcher/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = 'The request could not be completed.';
    try {
      message = ((await response.json()) as ApiErrorBody).message ?? message;
    } catch {
      // Keep the safe fallback when the server is unreachable or returns non-JSON.
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export function createRoom(displayName: string): Promise<CreateRoomResponse> {
  return request('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ displayName }),
  });
}

export function joinRoom(
  inviteToken: string,
  pin: string,
  displayName: string,
): Promise<JoinRoomResponse> {
  return request('/api/join', {
    method: 'POST',
    body: JSON.stringify({ inviteToken, pin, displayName }),
  });
}

export function recoverRoom(roomCode: string, recoveryCode: string): Promise<RecoverRoomResponse> {
  return request('/api/recover', {
    method: 'POST',
    body: JSON.stringify({ roomCode, recoveryCode }),
  });
}

export function fetchBootstrap(): Promise<BootstrapPayload> {
  return request('/api/bootstrap');
}

export function synchronize(participantId: string, revision: number, operations: SyncOperation[]): Promise<SyncResponse> {
  return request('/api/sync', {
    method: 'POST',
    body: JSON.stringify({ participantId, revision, operations }),
  });
}

export async function downloadBackup(): Promise<void> {
  const response = await fetch('/api/backups/export', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const body = (await response.json()) as ApiErrorBody;
    throw new ApiError(body.message, response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition');
  const filename = disposition?.match(/filename="([^"]+)"/)?.[1] ?? 'baby-name-matcher.sqlite';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
