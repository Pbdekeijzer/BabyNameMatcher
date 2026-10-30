import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Baby,
  Check,
  Cloud,
  CloudOff,
  Copy,
  Download,
  Heart,
  History as HistoryIcon,
  Home,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Star,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import type { BootstrapPayload, SyncOperation } from '@baby-name-matcher/shared';
import {
  ApiError,
  createRoom,
  downloadBackup,
  fetchBootstrap,
  joinRoom,
  recoverRoom,
  synchronize,
} from './api';
import { applyPendingOperations } from './client-state';
import {
  enqueueOperation,
  loadBootstrap,
  pendingOperations,
  removeOperations,
  requestPersistentStorage,
  resetForNewRoom,
  saveBootstrap,
} from './offline-store';
import { takeSyncBatch } from './sync-batches';

type Screen = 'discover' | 'matches' | 'add' | 'history' | 'settings';
type Phase = 'loading' | 'onboarding' | 'credentials' | 'ready';
type SyncStatus = 'online' | 'syncing' | 'offline' | 'recovery';
type NewOperation = SyncOperation extends infer Operation
  ? Operation extends SyncOperation
    ? Omit<Operation, 'operationId' | 'sequence' | 'clientCreatedAt'>
    : never
  : never;

interface OneTimeCredentials {
  roomCode: string;
  recoveryCode: string;
  inviteToken?: string;
  pin?: string;
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function invitationFromHash(): string {
  const match = window.location.hash.match(/^#join=(.+)$/);
  try {
    return match ? decodeURIComponent(match[1] ?? '') : '';
  } catch {
    return '';
  }
}

function nameMap(state: BootstrapPayload): Map<string, string> {
  return new Map(state.names.map((name) => [name.id, name.displayName]));
}

function normalizedName(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [state, setState] = useState<BootstrapPayload | null>(null);
  const stateRef = useRef<BootstrapPayload | null>(null);
  const [status, setStatus] = useState<SyncStatus>('offline');
  const [pendingCount, setPendingCount] = useState(0);
  const [screen, setScreen] = useState<Screen>('discover');
  const [toast, setToast] = useState<string | null>(null);
  const [matchName, setMatchName] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<OneTimeCredentials | null>(null);
  const [lastDecisionNameId, setLastDecisionNameId] = useState<string | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const syncPromise = useRef<Promise<void> | null>(null);

  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  const commitState = useCallback((next: BootstrapPayload) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const syncNow = useCallback(async () => {
    if (syncPromise.current) return syncPromise.current;
    const base = stateRef.current;
    if (!base) return;

    const run = async () => {
      setStatus('syncing');
      try {
        let latestBootstrap = base;
        let outgoing = takeSyncBatch(await pendingOperations());
        let firstNewMatchName: string | null = null;
        let firstRejectionMessage: string | null = null;
        const previousMatches = new Set(
          stateRef.current?.matches.map((match) => match.nameId) ?? [],
        );

        do {
          const response = await synchronize(latestBootstrap.participant.id, latestBootstrap.revision, outgoing);
          const finishedIds = [
            ...response.acknowledged,
            ...response.rejected.map((item) => item.operationId),
          ];
          if (outgoing.length > 0 && finishedIds.length === 0) {
            throw new Error('The server did not acknowledge the synchronization batch.');
          }
          await removeOperations(finishedIds);
          await saveBootstrap(response.bootstrap);
          latestBootstrap = response.bootstrap;

          if (!firstNewMatchName) {
            const newMatch = response.bootstrap.matches.find(
              (match) => !previousMatches.has(match.nameId),
            );
            if (newMatch) {
              firstNewMatchName =
                nameMap(response.bootstrap).get(newMatch.nameId) ?? 'this name';
            }
          }
          firstRejectionMessage ??=
            response.rejected[0]?.message ?? null;

          const stillPending = await pendingOperations();
          setPendingCount(stillPending.length);
          outgoing = takeSyncBatch(stillPending);
        } while (outgoing.length > 0);

        const remaining = await pendingOperations();
        const next = applyPendingOperations(latestBootstrap, remaining);
        commitState(next);
        setPendingCount(remaining.length);
        setStatus('online');
        if (firstNewMatchName) {
          setMatchName(firstNewMatchName);
        }
        if (firstRejectionMessage) {
          setToast(firstRejectionMessage);
        }
      } catch (error) {
        setPendingCount((await pendingOperations()).length);
        if (error instanceof ApiError && error.status === 401) {
          setStatus('recovery');
          setPhase('onboarding');
        } else {
          setStatus('offline');
        }
      }
    };

    syncPromise.current = run().finally(() => {
      syncPromise.current = null;
    });
    return syncPromise.current;
  }, [commitState]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await requestPersistentStorage().catch(() => false);
      const cached = await loadBootstrap();
      const queued = await pendingOperations();
      if (cancelled) return;
      setPendingCount(queued.length);
      if (cached) {
        commitState(applyPendingOperations(cached, queued));
        setPhase('ready');
        await syncNow();
        return;
      }
      try {
        const onlineState = await fetchBootstrap();
        if (cancelled) return;
        await saveBootstrap(onlineState);
        commitState(onlineState);
        setStatus('online');
        setPhase('ready');
      } catch (error) {
        if (cancelled) return;
        setStatus(error instanceof ApiError && error.status === 401 ? 'recovery' : 'offline');
        setPhase('onboarding');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [commitState, syncNow]);

  useEffect(() => {
    if (phase !== 'ready') return;
    const trigger = () => void syncNow();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') trigger();
    };
    window.addEventListener('online', trigger);
    window.addEventListener('focus', trigger);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(trigger, 15_000);
    const events = new EventSource('/api/events');
    events.addEventListener('revision', trigger);
    return () => {
      window.removeEventListener('online', trigger);
      window.removeEventListener('focus', trigger);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
      events.close();
    };
  }, [phase, syncNow]);

  useEffect(() => {
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SYNC_COMPLETE') void syncNow();
    };
    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, [syncNow]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const queueOperation = useCallback(
    async (operation: NewOperation) => {
      const current = stateRef.current;
      if (!current) return;
      let complete: SyncOperation;
      try {
        complete = await enqueueOperation(operation, current.participant.id);
      } catch (error) {
        setToast(error instanceof Error ? error.message : 'The change could not be saved.');
        return;
      }
      commitState(applyPendingOperations(current, [complete]));
      setPendingCount((count) => count + 1);
      void syncNow();
    },
    [commitState, syncNow],
  );

  const acceptAuthenticatedState = useCallback(
    async (bootstrap: BootstrapPayload, isRecovery: boolean) => {
      const existing = await loadBootstrap();
      if (!isRecovery || existing?.participant.id !== bootstrap.participant.id) {
        await resetForNewRoom();
      }
      await saveBootstrap(bootstrap);
      const queued = await pendingOperations();
      commitState(applyPendingOperations(bootstrap, queued));
      setPendingCount(queued.length);
      setStatus('online');
    },
    [commitState],
  );

  if (phase === 'loading') return <LoadingScreen />;
  if (phase === 'onboarding') {
    return (
      <Onboarding
        initialInviteToken={invitationFromHash()}
        recoverySuggested={status === 'recovery' && state !== null}
        onCreate={async (displayName) => {
          const response = await createRoom(displayName);
          await acceptAuthenticatedState(response.bootstrap, false);
          setCredentials({
            roomCode: response.bootstrap.room.publicCode,
            recoveryCode: response.recoveryCode,
            inviteToken: response.inviteToken,
            pin: response.pin,
          });
          setPhase('credentials');
        }}
        onJoin={async (inviteToken, pin, displayName) => {
          const response = await joinRoom(inviteToken, pin, displayName);
          await acceptAuthenticatedState(response.bootstrap, false);
          setCredentials({
            roomCode: response.bootstrap.room.publicCode,
            recoveryCode: response.recoveryCode,
          });
          window.history.replaceState(null, '', window.location.pathname);
          setPhase('credentials');
        }}
        onRecover={async (roomCode, recoveryCode) => {
          const response = await recoverRoom(roomCode, recoveryCode);
          await acceptAuthenticatedState(response.bootstrap, true);
          setPhase('ready');
          void syncNow();
        }}
      />
    );
  }
  if (phase === 'credentials' && credentials) {
    return (
      <CredentialsScreen
        credentials={credentials}
        onContinue={() => {
          setCredentials(null);
          setPhase('ready');
        }}
      />
    );
  }
  if (!state) return <LoadingScreen />;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <Heart size={18} fill="currentColor" />
          </span>
          <span>Name Matcher</span>
        </div>
        <SyncPill status={status} pendingCount={pendingCount} />
      </header>

      <main className="app-main">
        {screen === 'discover' && (
          <DiscoverScreen
            state={state}
            lastDecisionNameId={lastDecisionNameId}
            onDecision={(nameId, value) => {
              setLastDecisionNameId(nameId);
              void queueOperation({ kind: 'decision.set', nameId, value });
            }}
            onUndo={(nameId) => {
              setLastDecisionNameId(null);
              void queueOperation({ kind: 'decision.clear', nameId });
            }}
          />
        )}
        {screen === 'matches' && (
          <MatchesScreen
            state={state}
            onShortlist={(nameId, shortlisted) =>
              void queueOperation({ kind: 'shortlist.set', nameId, shortlisted })
            }
          />
        )}
        {screen === 'add' && (
          <AddNameScreen
            state={state}
            onAdd={(displayName) => {
              void queueOperation({
                kind: 'customName.add',
                nameId: crypto.randomUUID(),
                displayName,
              });
              setToast(`${displayName} was added for both of you.`);
            }}
          />
        )}
        {screen === 'history' && (
          <HistoryScreen
            state={state}
            onDecision={(nameId, value) =>
              void queueOperation({ kind: 'decision.set', nameId, value })
            }
            onClear={(nameId) => void queueOperation({ kind: 'decision.clear', nameId })}
          />
        )}
        {screen === 'settings' && (
          <SettingsScreen
            state={state}
            status={status}
            pendingCount={pendingCount}
            installAvailable={installPrompt !== null}
            onInstall={async () => {
              if (!installPrompt) return;
              await installPrompt.prompt();
              await installPrompt.userChoice;
              setInstallPrompt(null);
            }}
            onSync={() => void syncNow()}
            onBackup={async () => {
              try {
                await downloadBackup();
                setToast('Backup downloaded.');
              } catch (error) {
                setToast(error instanceof Error ? error.message : 'Backup failed.');
              }
            }}
          />
        )}
      </main>

      <BottomNavigation screen={screen} onChange={setScreen} matchCount={state.matches.length} />

      {toast && <div className="toast">{toast}</div>}
      {offlineReady && (
        <div className="update-banner">
          <span>Ready to use offline.</span>
          <button type="button" onClick={() => setOfflineReady(false)}>
            Got it
          </button>
        </div>
      )}
      {needRefresh && (
        <div className="update-banner">
          <span>An update is ready.</span>
          <button type="button" onClick={() => void updateServiceWorker(true)}>
            Update
          </button>
          <button type="button" onClick={() => setNeedRefresh(false)}>
            Later
          </button>
        </div>
      )}
      {matchName && <MatchCelebration name={matchName} onClose={() => setMatchName(null)} />}
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="centered-screen">
      <div className="loading-heart">
        <Heart fill="currentColor" />
      </div>
      <p>Gathering names…</p>
    </main>
  );
}

interface OnboardingProps {
  initialInviteToken: string;
  recoverySuggested: boolean;
  onCreate(displayName: string): Promise<void>;
  onJoin(inviteToken: string, pin: string, displayName: string): Promise<void>;
  onRecover(roomCode: string, recoveryCode: string): Promise<void>;
}

function Onboarding(props: OnboardingProps) {
  const [mode, setMode] = useState<'welcome' | 'create' | 'join' | 'recover'>(
    props.initialInviteToken ? 'join' : props.recoverySuggested ? 'recover' : 'welcome',
  );
  const [displayName, setDisplayName] = useState('');
  const [inviteToken, setInviteToken] = useState(props.initialInviteToken);
  const [pin, setPin] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="onboarding-shell">
      <section className="onboarding-card">
        <div className="hero-mark">
          <Baby size={34} />
          <Heart className="hero-heart" size={22} fill="currentColor" />
        </div>
        <p className="eyebrow">A private little project</p>
        <h1>Find the name you both love.</h1>
        <p className="intro-copy">
          Swipe separately, celebrate the names that match, and keep every choice safe for later.
        </p>

        {mode === 'welcome' && (
          <div className="button-stack">
            <button className="primary-button" type="button" onClick={() => setMode('create')}>
              Create our room
            </button>
            <button className="secondary-button" type="button" onClick={() => setMode('join')}>
              Join my partner
            </button>
            <button className="text-button" type="button" onClick={() => setMode('recover')}>
              I have a recovery code
            </button>
          </div>
        )}

        {mode === 'create' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(() => props.onCreate(displayName));
            }}
          >
            <Field label="What should we call you?">
              <input
                autoComplete="name"
                maxLength={40}
                required
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Your name"
              />
            </Field>
            <FormActions busy={busy} label="Create private room" onBack={() => setMode('welcome')} />
          </form>
        )}

        {mode === 'join' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(() => props.onJoin(inviteToken, pin, displayName));
            }}
          >
            {!props.initialInviteToken && (
              <Field label="Invitation token">
                <input
                  required
                  value={inviteToken}
                  onChange={(event) => setInviteToken(event.target.value.trim())}
                  placeholder="Paste the token from your partner"
                />
              </Field>
            )}
            <Field label="Six-digit PIN">
              <input
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
                placeholder="000000"
              />
            </Field>
            <Field label="What should we call you?">
              <input
                autoComplete="name"
                maxLength={40}
                required
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Your name"
              />
            </Field>
            <FormActions busy={busy} label="Join our room" onBack={() => setMode('welcome')} />
          </form>
        )}

        {mode === 'recover' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(() => props.onRecover(roomCode, recoveryCode));
            }}
          >
            <p className="form-note">
              Recovery reconnects this phone without revealing your partner’s private choices.
            </p>
            <Field label="Room code">
              <input
                autoCapitalize="characters"
                required
                value={roomCode}
                onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                placeholder="ABCD2345"
              />
            </Field>
            <Field label="Personal recovery code">
              <input
                autoCapitalize="characters"
                required
                value={recoveryCode}
                onChange={(event) => setRecoveryCode(event.target.value.toUpperCase())}
                placeholder="XXXXXX-XXXXXX-XXXXXX-XXXXXX"
              />
            </Field>
            <FormActions busy={busy} label="Recover my choices" onBack={() => setMode('welcome')} />
          </form>
        )}
        {error && <p className="form-error">{error}</p>}
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function FormActions({ busy, label, onBack }: { busy: boolean; label: string; onBack(): void }) {
  return (
    <div className="form-actions">
      <button className="primary-button" disabled={busy} type="submit">
        {busy ? 'One moment…' : label}
      </button>
      <button className="text-button" type="button" onClick={onBack}>
        Back
      </button>
    </div>
  );
}

function CredentialsScreen({
  credentials,
  onContinue,
}: {
  credentials: OneTimeCredentials;
  onContinue(): void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const inviteUrl = credentials.inviteToken
    ? `${window.location.origin}${window.location.pathname}#join=${encodeURIComponent(credentials.inviteToken)}`
    : null;
  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
  };
  return (
    <main className="onboarding-shell">
      <section className="onboarding-card credentials-card">
        <div className="success-mark">
          <Check size={30} />
        </div>
        <p className="eyebrow">You’re connected</p>
        <h1>Save your recovery details.</h1>
        <p className="intro-copy">
          Keep your personal recovery code somewhere private. It is the only way back if this phone’s app data is cleared.
        </p>
        <SecretRow label="Room code" value={credentials.roomCode} onCopy={copy} copied={copied} />
        <SecretRow
          label="Your recovery code"
          value={credentials.recoveryCode}
          onCopy={copy}
          copied={copied}
        />
        {inviteUrl && credentials.pin && (
          <>
            <div className="divider" />
            <p className="form-note">Send the link and PIN to your partner privately.</p>
            <SecretRow label="Partner invite link" value={inviteUrl} onCopy={copy} copied={copied} />
            <SecretRow label="Partner PIN" value={credentials.pin} onCopy={copy} copied={copied} />
          </>
        )}
        <button className="primary-button" type="button" onClick={onContinue}>
          I’ve saved these
        </button>
      </section>
    </main>
  );
}

function SecretRow({
  label,
  value,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  onCopy(label: string, value: string): Promise<void>;
  copied: string | null;
}) {
  return (
    <div className="secret-row">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <button type="button" aria-label={`Copy ${label}`} onClick={() => void onCopy(label, value)}>
        {copied === label ? <Check size={19} /> : <Copy size={19} />}
      </button>
    </div>
  );
}

function SyncPill({ status, pendingCount }: { status: SyncStatus; pendingCount: number }) {
  const label =
    status === 'syncing'
      ? 'Syncing'
      : pendingCount > 0
        ? `${pendingCount} waiting`
        : status === 'online'
          ? 'Saved'
          : status === 'recovery'
            ? 'Recover access'
            : 'Offline';
  return (
    <div className={`sync-pill ${status}`} title={label}>
      {status === 'online' && pendingCount === 0 ? (
        <Cloud size={15} />
      ) : status === 'syncing' ? (
        <RefreshCw className="spin" size={15} />
      ) : (
        <CloudOff size={15} />
      )}
      <span>{label}</span>
    </div>
  );
}

function DiscoverScreen({
  state,
  lastDecisionNameId,
  onDecision,
  onUndo,
}: {
  state: BootstrapPayload;
  lastDecisionNameId: string | null;
  onDecision(nameId: string, value: 'like' | 'pass'): void;
  onUndo(nameId: string): void;
}) {
  const names = useMemo(() => nameMap(state), [state]);
  const currentId = state.queue[0];
  const currentName = currentId ? names.get(currentId) : null;
  const [dragX, setDragX] = useState(0);
  const pointerStart = useRef<number | null>(null);

  useEffect(() => setDragX(0), [currentId]);

  const decide = (value: 'like' | 'pass') => {
    if (currentId) onDecision(currentId, value);
  };
  const pointerUp = () => {
    if (Math.abs(dragX) > 85) decide(dragX > 0 ? 'like' : 'pass');
    setDragX(0);
    pointerStart.current = null;
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') decide('pass');
    if (event.key === 'ArrowRight') decide('like');
  };

  return (
    <section className="screen discover-screen">
      <div className="screen-heading compact-heading">
        <div>
          <p className="eyebrow">Your private picks</p>
          <h1>What feels right?</h1>
        </div>
        <span className="progress-count">
          {state.decisions.length} / {state.names.length}
        </span>
      </div>
      <div className="progress-track" aria-hidden="true">
        <span style={{ width: `${(state.decisions.length / Math.max(state.names.length, 1)) * 100}%` }} />
      </div>

      {currentId && currentName ? (
        <div className="card-stage">
          <div
            className={`name-card ${dragX > 35 ? 'lean-like' : dragX < -35 ? 'lean-pass' : ''}`}
            role="group"
            aria-label={`Name: ${currentName}. Use the buttons or left and right arrow keys.`}
            tabIndex={0}
            onKeyDown={keyboard}
            onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
              pointerStart.current = event.clientX;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
              if (pointerStart.current !== null) setDragX(event.clientX - pointerStart.current);
            }}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
            style={{ transform: `translateX(${dragX}px) rotate(${dragX / 24}deg)` }}
          >
            <span className="swipe-stamp pass-stamp">PASS</span>
            <h2>{currentName}</h2>
            <span className="swipe-stamp like-stamp">LIKE</span>
          </div>
          <div className="decision-actions">
            <button className="decision-button pass" type="button" aria-label="Pass" onClick={() => decide('pass')}>
              <X size={31} />
            </button>
            <button className="undo-button" type="button" disabled={!lastDecisionNameId} onClick={() => lastDecisionNameId && onUndo(lastDecisionNameId)}>
              <RotateCcw size={18} />
              Undo
            </button>
            <button className="decision-button like" type="button" aria-label="Like" onClick={() => decide('like')}>
              <Heart size={28} fill="currentColor" />
            </button>
          </div>
          <p className="gesture-hint">Swipe left to pass · right to like</p>
        </div>
      ) : (
        <EmptyState
          icon={<Sparkles size={31} />}
          title="You’ve seen every name"
          copy="Add your own ideas or revisit your history while your partner catches up."
        />
      )}
    </section>
  );
}

function MatchesScreen({
  state,
  onShortlist,
}: {
  state: BootstrapPayload;
  onShortlist(nameId: string, shortlisted: boolean): void;
}) {
  const names = nameMap(state);
  const shortlist = state.matches.filter((match) => state.shortlist.includes(match.nameId));
  const otherMatches = state.matches.filter((match) => !state.shortlist.includes(match.nameId));
  return (
    <section className="screen">
      <div className="screen-heading">
        <p className="eyebrow">The lovely overlap</p>
        <h1>Your matches</h1>
        <p>{state.matches.length} names you both liked, with no awkward reveals.</p>
      </div>
      {state.matches.length === 0 ? (
        <EmptyState
          icon={<Heart size={31} />}
          title="No matches yet"
          copy="Keep swiping. A mutual like will appear here for both of you."
        />
      ) : (
        <>
          {shortlist.length > 0 && (
            <NameSection title="Shared shortlist" accent>
              {shortlist.map((match) => (
                <NameListRow
                  key={match.nameId}
                  name={names.get(match.nameId) ?? 'Unknown name'}
                  actionLabel="Remove from shortlist"
                  action={<Star size={20} fill="currentColor" />}
                  onAction={() => onShortlist(match.nameId, false)}
                />
              ))}
            </NameSection>
          )}
          <NameSection title={shortlist.length ? 'All other matches' : 'All matches'}>
            {otherMatches.map((match) => (
              <NameListRow
                key={match.nameId}
                name={names.get(match.nameId) ?? 'Unknown name'}
                actionLabel="Add to shortlist"
                action={<Star size={20} />}
                onAction={() => onShortlist(match.nameId, true)}
              />
            ))}
          </NameSection>
        </>
      )}
    </section>
  );
}

function AddNameScreen({ state, onAdd }: { state: BootstrapPayload; onAdd(name: string): void }) {
  const names = nameMap(state);
  const [value, setValue] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const existing = useMemo(
    () => new Set(state.names.map((name) => normalizedName(name.displayName))),
    [state.names],
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const clean = value.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!/^[\p{L}\p{M}][\p{L}\p{M}'’.-]*(?: [\p{L}\p{M}][\p{L}\p{M}'’.-]*)*$/u.test(clean)) {
      setError('Use letters, spaces, apostrophes, hyphens, or periods.');
      return;
    }
    if (existing.has(normalizedName(clean))) {
      setError('That name already exists in the list.');
      return;
    }
    setError(null);
    setConfirming(clean);
  };
  return (
    <section className="screen">
      <div className="screen-heading">
        <p className="eyebrow">Your own inspiration</p>
        <h1>Add a name</h1>
        <p>It starts unreviewed for both of you. Your partner won’t be told who added it.</p>
      </div>
      <form className="add-form" onSubmit={submit}>
        <label htmlFor="custom-name">Baby name</label>
        <div className="add-control">
          <input id="custom-name" maxLength={40} value={value} onChange={(event) => setValue(event.target.value)} placeholder="Type a name" />
          <button type="submit" aria-label="Review name">
            <Plus size={23} />
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>
      <NameSection title={`Added by me · ${state.addedByMe.length}`}>
        {state.addedByMe.length === 0 ? (
          <p className="quiet-copy">Names you add will be collected privately here.</p>
        ) : (
          state.addedByMe.map((id) => <NameListRow key={id} name={names.get(id) ?? 'Pending name'} />)
        )}
      </NameSection>
      {confirming && (
        <div className="modal-backdrop" role="presentation">
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <p className="eyebrow">Check the spelling</p>
            <h2 id="confirm-title">Add {confirming}?</h2>
            <p>It will join both private swipe queues.</p>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => setConfirming(null)}>
                Go back
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  onAdd(confirming);
                  setValue('');
                  setConfirming(null);
                }}
              >
                Add name
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function HistoryScreen({
  state,
  onDecision,
  onClear,
}: {
  state: BootstrapPayload;
  onDecision(nameId: string, value: 'like' | 'pass'): void;
  onClear(nameId: string): void;
}) {
  const [filter, setFilter] = useState<'like' | 'pass'>('like');
  const [search, setSearch] = useState('');
  const names = nameMap(state);
  const decisions = state.decisions.filter((decision) => decision.value === filter);
  const normalizedSearch = search
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('nl-NL');
  const visibleDecisions = normalizedSearch
    ? decisions.filter((decision) =>
        (names.get(decision.nameId) ?? '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLocaleLowerCase('nl-NL')
          .includes(normalizedSearch),
      )
    : decisions;
  const listLabel = filter === 'like' ? 'likes' : 'passes';
  return (
    <section className="screen">
      <div className="screen-heading">
        <p className="eyebrow">Only visible to you</p>
        <h1>Your history</h1>
        <p>Change your mind at any time. Your partner still sees only mutual likes.</p>
      </div>
      <div className="segmented-control" role="tablist" aria-label="Decision history">
        <button type="button" className={filter === 'like' ? 'active' : ''} onClick={() => setFilter('like')}>
          Likes · {state.decisions.filter((item) => item.value === 'like').length}
        </button>
        <button type="button" className={filter === 'pass' ? 'active' : ''} onClick={() => setFilter('pass')}>
          Passes · {state.decisions.filter((item) => item.value === 'pass').length}
        </button>
      </div>
      <label className="history-search" htmlFor="history-search">
        <Search aria-hidden="true" size={19} />
        <input
          id="history-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={`Search ${listLabel}`}
          aria-label={`Search ${listLabel}`}
          autoComplete="off"
          spellCheck="false"
        />
      </label>
      {decisions.length === 0 ? (
        <p className="quiet-copy padded-copy">Nothing in this list yet.</p>
      ) : visibleDecisions.length === 0 ? (
        <p className="quiet-copy padded-copy">No {listLabel} match “{search.trim()}”.</p>
      ) : (
        <div className="name-list">
          {visibleDecisions.map((decision) => (
            <div className="history-row" key={decision.nameId}>
              <strong>{names.get(decision.nameId) ?? 'Unknown name'}</strong>
              <div>
                <button
                  type="button"
                  onClick={() => onDecision(decision.nameId, filter === 'like' ? 'pass' : 'like')}
                >
                  {filter === 'like' ? 'Move to passes' : 'Move to likes'}
                </button>
                <button type="button" onClick={() => onClear(decision.nameId)}>
                  Review again
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SettingsScreen({
  state,
  status,
  pendingCount,
  installAvailable,
  onInstall,
  onSync,
  onBackup,
}: {
  state: BootstrapPayload;
  status: SyncStatus;
  pendingCount: number;
  installAvailable: boolean;
  onInstall(): Promise<void>;
  onSync(): void;
  onBackup(): Promise<void>;
}) {
  return (
    <section className="screen">
      <div className="screen-heading">
        <p className="eyebrow">Your private room</p>
        <h1>Settings</h1>
      </div>
      <div className="settings-card couple-card">
        <div className="avatar">{state.participant.displayName.charAt(0).toUpperCase()}</div>
        <div className="couple-link" aria-hidden="true"><Heart size={17} fill="currentColor" /></div>
        <div className="avatar partner">{state.partnerName?.charAt(0).toUpperCase() ?? '?'}</div>
        <div className="couple-names">
          <strong>{state.participant.displayName}</strong>
          <span>&amp;</span>
          <strong>{state.partnerName ?? 'Waiting for partner'}</strong>
        </div>
      </div>
      <div className="settings-list">
        <div className="settings-row">
          <div className="settings-icon"><Users size={20} /></div>
          <div><span>Room code</span><strong>{state.room.publicCode}</strong></div>
        </div>
        <div className="settings-row">
          <div className="settings-icon"><Wifi size={20} /></div>
          <div><span>Synchronization</span><strong>{status === 'online' ? 'Everything saved' : status === 'syncing' ? 'Saving changes' : `${pendingCount} waiting for the desktop`}</strong></div>
          <button className="icon-button" type="button" aria-label="Sync now" onClick={onSync}><RefreshCw size={19} /></button>
        </div>
        {installAvailable && (
          <button className="settings-action" type="button" onClick={() => void onInstall()}>
            <div className="settings-icon"><Home size={20} /></div>
            <div><strong>Install on this phone</strong><span>Add the app to your Android home screen.</span></div>
          </button>
        )}
        {state.participant.role === 'creator' && (
          <button className="settings-action" type="button" onClick={() => void onBackup()}>
            <div className="settings-icon"><Download size={20} /></div>
            <div><strong>Download a backup</strong><span>Contains both partners' private votes. Keep this file private.</span></div>
          </button>
        )}
      </div>
      <div className="privacy-note">
        <CloudOff size={22} />
        <div>
          <strong>Designed for an occasionally-offline home server</strong>
          <p>Your phone saves every tap locally first. Matches appear after both phones have synchronized.</p>
        </div>
      </div>
    </section>
  );
}

function NameSection({
  title,
  accent = false,
  children,
}: {
  title: string;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`name-section ${accent ? 'accent' : ''}`}>
      <h2>{title}</h2>
      <div className="name-list">{children}</div>
    </section>
  );
}

function NameListRow({
  name,
  action,
  actionLabel,
  onAction,
}: {
  name: string;
  action?: React.ReactNode;
  actionLabel?: string;
  onAction?(): void;
}) {
  return (
    <div className="name-list-row">
      <strong>{name}</strong>
      {action && onAction && (
        <button type="button" aria-label={`${actionLabel ?? 'Update'} ${name}`} onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

function EmptyState({ icon, title, copy }: { icon: React.ReactNode; title: string; copy: string }) {
  return (
    <div className="empty-state">
      <div>{icon}</div>
      <h2>{title}</h2>
      <p>{copy}</p>
    </div>
  );
}

function BottomNavigation({
  screen,
  onChange,
  matchCount,
}: {
  screen: Screen;
  onChange(screen: Screen): void;
  matchCount: number;
}) {
  const items: Array<{ screen: Screen; label: string; icon: React.ReactNode }> = [
    { screen: 'discover', label: 'Discover', icon: <Sparkles size={21} /> },
    { screen: 'matches', label: 'Matches', icon: <Heart size={21} /> },
    { screen: 'add', label: 'Add', icon: <Plus size={22} /> },
    { screen: 'history', label: 'History', icon: <HistoryIcon size={21} /> },
    { screen: 'settings', label: 'Settings', icon: <SettingsIcon size={21} /> },
  ];
  return (
    <nav className="bottom-nav" aria-label="Main navigation">
      {items.map((item) => (
        <button
          key={item.screen}
          type="button"
          className={screen === item.screen ? 'active' : ''}
          aria-current={screen === item.screen ? 'page' : undefined}
          onClick={() => onChange(item.screen)}
        >
          <span className="nav-icon">
            {item.icon}
            {item.screen === 'matches' && matchCount > 0 && <i>{matchCount}</i>}
          </span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function MatchCelebration({ name, onClose }: { name: string; onClose(): void }) {
  return (
    <div className="modal-backdrop match-backdrop" role="presentation">
      <div className="match-dialog" role="dialog" aria-modal="true" aria-labelledby="match-title">
        <div className="match-hearts"><Heart fill="currentColor" /><Heart fill="currentColor" /></div>
        <p className="eyebrow">You both felt it</p>
        <h2 id="match-title">It’s a match!</h2>
        <strong>{name}</strong>
        <p>This one belongs on the list.</p>
        <button className="primary-button" type="button" onClick={onClose}>Keep discovering</button>
      </div>
    </div>
  );
}
