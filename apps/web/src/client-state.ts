import type { BootstrapPayload, Decision, SyncOperation } from '@baby-name-matcher/shared';

function localTime(operation: SyncOperation): string {
  return operation.clientCreatedAt ?? new Date().toISOString();
}

export function applyPendingOperations(
  canonical: BootstrapPayload,
  operations: SyncOperation[],
): BootstrapPayload {
  const state = structuredClone(canonical);
  for (const operation of [...operations].sort((left, right) => left.sequence - right.sequence)) {
    if (operation.kind === 'customName.add') {
      if (!state.names.some((name) => name.id === operation.nameId)) {
        state.names.push({
          id: operation.nameId,
          displayName: operation.displayName.trim().replace(/\s+/g, ' '),
        });
        state.queue.unshift(operation.nameId);
        state.addedByMe.unshift(operation.nameId);
      }
      continue;
    }

    if (operation.kind === 'shortlist.set') {
      state.shortlist = operation.shortlisted
        ? [operation.nameId, ...state.shortlist.filter((id) => id !== operation.nameId)]
        : state.shortlist.filter((id) => id !== operation.nameId);
      continue;
    }

    const previous = state.decisions.find((decision) => decision.nameId === operation.nameId);
    state.decisions = state.decisions.filter((decision) => decision.nameId !== operation.nameId);
    if (operation.kind === 'decision.set') {
      const decision: Decision = {
        nameId: operation.nameId,
        value: operation.value,
        updatedAt: localTime(operation),
      };
      state.decisions.unshift(decision);
      state.queue = state.queue.filter((id) => id !== operation.nameId);
      if (operation.value === 'pass' && previous?.value === 'like') {
        state.matches = state.matches.filter((match) => match.nameId !== operation.nameId);
        state.shortlist = state.shortlist.filter((id) => id !== operation.nameId);
      }
    } else {
      state.queue = [operation.nameId, ...state.queue.filter((id) => id !== operation.nameId)];
      if (previous?.value === 'like') {
        state.matches = state.matches.filter((match) => match.nameId !== operation.nameId);
        state.shortlist = state.shortlist.filter((id) => id !== operation.nameId);
      }
    }
  }
  return state;
}
