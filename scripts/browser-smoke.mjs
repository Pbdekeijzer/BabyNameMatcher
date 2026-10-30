import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const managesServer = !process.env.SMOKE_BASE_URL;
const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3010';
const debuggingPort = Number(process.env.SMOKE_DEBUG_PORT ?? 9333);
const smokeRunId = Date.now();
const browserCandidates = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const browserPath = browserCandidates.find((candidate) => existsSync(candidate));

if (!browserPath) {
  throw new Error('Set BROWSER_PATH to an Edge or Chrome executable.');
}

const runtimeDirectory = resolve('runtime');
const profileDirectory = resolve(runtimeDirectory, `browser-smoke-${smokeRunId}`);
const serverRuntimeDirectory = resolve(runtimeDirectory, `browser-smoke-app-${smokeRunId}`);
const screenshotPath = resolve(runtimeDirectory, 'browser-smoke-mobile.png');
mkdirSync(profileDirectory, { recursive: true });

let appServer;
let appServerDiagnostics = '';

async function startAppServer() {
  if (!managesServer) return;
  const address = new URL(baseUrl);
  appServer = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      COOKIE_SECURE: 'false',
      HOST: address.hostname,
      LOG_LEVEL: 'fatal',
      PORT: address.port,
      RUNTIME_DIR: serverRuntimeDirectory,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  appServer.stderr.on('data', (chunk) => {
    appServerDiagnostics = `${appServerDiagnostics}${chunk}`.slice(-4_000);
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The application is still starting.
    }
    await pause(100);
  }
  throw new Error(`Application server did not start.\n${appServerDiagnostics}`);
}

async function stopAppServer() {
  if (!managesServer || !appServer || appServer.exitCode !== null) return;
  const exited = new Promise((resolveExit) => appServer.once('exit', resolveExit));
  appServer.kill();
  await Promise.race([exited, pause(3_000)]);
}

const browser = spawn(
  browserPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
);

let browserDiagnostics = '';
browser.stderr.on('data', (chunk) => {
  browserDiagnostics = `${browserDiagnostics}${chunk}`.slice(-4_000);
});

function pause(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForDebuggingEndpoint() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/version`);
      if (response.ok) return response.json();
    } catch {
      // The browser is still starting.
    }
    await pause(250);
  }
  throw new Error(`Browser debugging endpoint did not start.\n${browserDiagnostics}`);
}

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.addEventListener('open', resolveReady, { once: true });
      this.socket.addEventListener('error', rejectReady, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  async send(method, params = {}, sessionId) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise((resolveResponse, rejectResponse) => {
      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
    });
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return response;
  }

  onMessage(listener) {
    this.listeners.add(listener);
  }
}

const pageExpression = {
  body: `document.body?.innerText ?? ''`,
  clickButton(label) {
    return `(() => {
      const button = [...document.querySelectorAll('button')].find(
        (candidate) =>
          candidate.textContent.trim() === ${JSON.stringify(label)} ||
          candidate.getAttribute('aria-label') === ${JSON.stringify(label)} ||
          [...candidate.querySelectorAll('span')].some((part) => part.textContent.trim() === ${JSON.stringify(label)}),
      );
      if (!button) return false;
      button.click();
      return true;
    })()`;
  },
  fillByLabel(label, value) {
    return `(() => {
      const field = [...document.querySelectorAll('label')].find(
        (candidate) => candidate.querySelector('span')?.textContent.trim() === ${JSON.stringify(label)},
      )?.querySelector('input');
      if (!field) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`;
  },
  fillById(id, value) {
    return `(() => {
      const field = document.getElementById(${JSON.stringify(id)});
      if (!field) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`;
  },
};

async function run() {
  await startAppServer();
  const version = await waitForDebuggingEndpoint();
  const cdp = new CdpClient(version.webSocketDebuggerUrl);
  const pageErrors = [];
  cdp.onMessage((message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails.text);
    }
  });

  const createPage = async (url) => {
    const { browserContextId } = await cdp.send('Target.createBrowserContext');
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 412, height: 915, deviceScaleFactor: 1, mobile: true },
      sessionId,
    );
    await cdp.send('Page.navigate', { url }, sessionId);
    return { browserContextId, sessionId, targetId };
  };

  const evaluate = async (page, expression, awaitPromise = true) => {
    const result = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true },
      page.sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };

  const waitFor = async (page, predicate, description, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(page, predicate)) return;
      await pause(100);
    }
    const body = String(await evaluate(page, pageExpression.body))
      .replace(/#join=\S+/g, '#join=[REDACTED]')
      .replace(/\b[A-Z0-9]{6}(?:-[A-Z0-9]{6}){3}\b/g, '[REDACTED]')
      .replace(/\b\d{6}\b/g, '[REDACTED]');
    throw new Error(`Timed out waiting for ${description}. Visible text: ${body.slice(0, 500)}`);
  };

  const click = async (page, label) => {
    const clicked = await evaluate(page, pageExpression.clickButton(label));
    if (!clicked) throw new Error(`Could not find button: ${label}`);
  };

  const fillByLabel = async (page, label, value) => {
    const filled = await evaluate(page, pageExpression.fillByLabel(label, value));
    if (!filled) throw new Error(`Could not find field: ${label}`);
  };

  const malformedInvite = await createPage(`${baseUrl}/#join=%`);
  await waitFor(malformedInvite, `document.body?.innerText.includes('Find the name you both love.')`, 'malformed invite fallback');
  await cdp.send('Target.disposeBrowserContext', { browserContextId: malformedInvite.browserContextId });
  const creator = await createPage(baseUrl);
  await waitFor(
    creator,
    `document.body?.innerText.includes('Find the name you both love.')`,
    'the welcome screen',
  );
  await click(creator, 'Create our room');
  await fillByLabel(creator, 'What should we call you?', 'Alex');
  await click(creator, 'Create private room');
  await waitFor(
    creator,
    `document.body?.innerText.includes('Save your recovery details.')`,
    'creator credentials',
  );

  const invitation = await evaluate(
    creator,
    `(() => {
      const rows = [...document.querySelectorAll('.secret-row')];
      const valueFor = (label) => rows.find((row) => row.querySelector('span')?.textContent.trim() === label)?.querySelector('strong')?.textContent.trim();
      return { inviteUrl: valueFor('Partner invite link'), pin: valueFor('Partner PIN') };
    })()`,
  );
  if (!invitation?.inviteUrl || !invitation?.pin) throw new Error('Invitation details were not rendered.');

  await click(creator, 'I’ve saved these');
  await waitFor(creator, `document.querySelector('.name-card h2') !== null`, 'the first name card');

  const partner = await createPage(invitation.inviteUrl);
  await waitFor(partner, `document.body?.innerText.includes('Six-digit PIN')`, 'the partner join form');
  await fillByLabel(partner, 'Six-digit PIN', invitation.pin);
  await fillByLabel(partner, 'What should we call you?', 'Robin');
  await click(partner, 'Join our room');
  await waitFor(
    partner,
    `document.body?.innerText.includes('Save your recovery details.')`,
    'partner credentials',
  );
  await click(partner, 'I’ve saved these');
  await waitFor(partner, `document.querySelector('.name-card h2') !== null`, 'the partner name card');
  const matchedName = await evaluate(partner, `document.querySelector('.name-card h2').textContent.trim()`);
  await evaluate(
    creator,
    `(async () => {
      const bootstrap = await fetch('/api/bootstrap').then((response) => response.json());
      const candidate = bootstrap.names.find((name) => name.displayName === ${JSON.stringify(matchedName)});
      if (!candidate) throw new Error('Shared catalogue candidate was not found.');
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revision: bootstrap.revision,
          operations: [{
            operationId: crypto.randomUUID(),
            sequence: 1,
            kind: 'decision.set',
            nameId: candidate.id,
            value: 'like',
          }],
        }),
      });
      if (!response.ok) throw new Error('Creator decision could not be synchronized.');
      return true;
    })()`,
  );
  await pause(500);
  const partnerCardAfterCreatorVote = await evaluate(
    partner,
    `document.querySelector('.name-card h2').textContent.trim()`,
  );
  if (partnerCardAfterCreatorVote !== matchedName) {
    throw new Error('A partner vote changed the other participant’s catalogue order.');
  }
  await click(partner, 'Like');
  await waitFor(partner, `document.body?.innerText.includes('It’s a match!')`, 'the match celebration');
  await click(partner, 'Keep discovering');
  await click(partner, 'Matches');
  await waitFor(
    partner,
    `document.body?.innerText.includes('Your matches') && document.body.innerText.includes(${JSON.stringify(matchedName)})`,
    'the mutual match list',
  );
  await click(partner, `Add to shortlist ${matchedName}`);
  await waitFor(partner, `document.body?.innerText.toUpperCase().includes('SHARED SHORTLIST')`, 'the shared shortlist');

  await click(partner, 'Add');
  await waitFor(partner, `document.getElementById('custom-name') !== null`, 'the custom-name form');
  const duplicateFilled = await evaluate(
    partner,
    pageExpression.fillById('custom-name', `  ${matchedName.toUpperCase()}  `),
  );
  if (!duplicateFilled) throw new Error('Could not fill the duplicate-name check.');
  await click(partner, 'Review name');
  await waitFor(
    partner,
    `document.body?.innerText.includes('That name already exists in the list.') && document.querySelector('[role="dialog"]') === null`,
    'duplicate-name feedback',
  );
  const customName = 'Solander';
  const customFilled = await evaluate(partner, pageExpression.fillById('custom-name', customName));
  if (!customFilled) throw new Error('Could not fill the custom-name field.');
  await click(partner, 'Review name');
  await waitFor(partner, `document.body?.innerText.includes('Add ${customName}?')`, 'spelling confirmation');
  await click(partner, 'Add name');
  await waitFor(
    partner,
    `document.body?.innerText.includes('${customName} was added for both of you.') && document.body.innerText.toUpperCase().includes('ADDED BY ME · 1')`,
    'custom-name confirmation',
  );

  const ready = await evaluate(
    partner,
    `(async () => { const registration = await navigator.serviceWorker.ready; return Boolean(registration.active); })()`,
  );
  if (!ready) throw new Error('The service worker did not become active.');
  // A reload intentionally opens Discover; the current navigation tab is not persisted.
  // Always exercise this path instead of racing the worker's initial clients.claim().
  await cdp.send('Page.reload', {}, partner.sessionId);
  await waitFor(partner,
    `Boolean(navigator.serviceWorker.controller) && document.querySelector('.name-card h2') !== null`,
    'the service-worker-controlled app');
  await cdp.send('Network.enable', {}, partner.sessionId);
  if (managesServer) {
    await stopAppServer();
  } else {
    await cdp.send(
      'Network.emulateNetworkConditions',
      { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
      partner.sessionId,
    );
  }
  await click(partner, 'Discover');
  await waitFor(partner, `document.querySelector('.name-card h2') !== null`, 'an offline name card');
  const queuedOfflineRatings = await evaluate(
    partner,
    `(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('baby-name-matcher', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const read = (store, key) => new Promise((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const bootstrap = await read('state', 'bootstrap');
      const lastSequence = (await read('state', 'sequence')) ?? 0;
      const nameIds = bootstrap.queue.slice(0, 1000);
      const transaction = db.transaction(['state', 'outbox'], 'readwrite');
      const outbox = transaction.objectStore('outbox');
      nameIds.forEach((nameId, index) => outbox.put({
        operationId: crypto.randomUUID(),
        sequence: lastSequence + index + 1,
        clientCreatedAt: new Date().toISOString(),
        kind: 'decision.set',
        nameId,
        value: index % 2 === 0 ? 'like' : 'pass',
      }));
      transaction.objectStore('state').put(lastSequence + nameIds.length, 'sequence');
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      db.close();
      return nameIds.length;
    })()`,
  );
  if (queuedOfflineRatings !== 1000) {
    throw new Error(`Expected to queue 1,000 offline ratings; queued ${queuedOfflineRatings}.`);
  }
  await cdp.send('Page.reload', {}, partner.sessionId);
  await waitFor(
    partner,
    `document.body?.innerText.includes('What feels right?') && document.body.innerText.includes('1000 waiting')`,
    'the 1,000-rating offline reload',
  );
  if (managesServer) {
    await startAppServer();
    await evaluate(partner, `window.dispatchEvent(new Event('online')); true`);
  } else {
    await cdp.send(
      'Network.emulateNetworkConditions',
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      partner.sessionId,
    );
  }
  await waitFor(
    partner,
    `document.body?.innerText.includes('Saved')`,
    'the 1,000 queued ratings to synchronize',
    30_000,
  );

  await click(partner, 'History');
  await waitFor(partner, `document.getElementById('history-search') !== null`, 'the history search field');
  const passesSelected = await evaluate(
    partner,
    `(() => {
      const button = [...document.querySelectorAll('.segmented-control button')].find((item) => item.textContent.trim().startsWith('Passes'));
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  if (!passesSelected) throw new Error('Could not open the passes list.');
  await waitFor(partner, `document.querySelectorAll('.history-row').length > 1`, 'the passes history');
  const passName = await evaluate(partner, `document.querySelector('.history-row strong').textContent.trim()`);
  const historySearchFilled = await evaluate(
    partner,
    pageExpression.fillById('history-search', passName.toLocaleLowerCase('nl-NL')),
  );
  if (!historySearchFilled) throw new Error('Could not fill the history search field.');
  await waitFor(
    partner,
    `(() => {
      const rows = [...document.querySelectorAll('.history-row strong')];
      return rows.length >= 1 && rows.every((row) => row.textContent.trim() === ${JSON.stringify(passName)});
    })()`,
    'the passes list to be filtered by name',
  );

  const screenshot = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false },
    partner.sessionId,
  );
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  if (pageErrors.length > 0) {
    throw new Error(`Browser page exceptions: ${pageErrors.join('; ')}`);
  }

  await cdp.send('Browser.close');
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        verified: [
          'room creation',
          'private partner join',
          'independent queue ordering',
          'mutual match',
          'shared shortlist',
          'duplicate custom-name feedback',
          'custom name',
          '1,000-rating offline queue, reload, and batched sync',
          'likes and passes search filter',
        ],
        screenshot: screenshotPath,
      },
      null,
      2,
    ),
  );
}

let failure;
try {
  await run();
} catch (error) {
  failure = error;
} finally {
  await stopAppServer();
  if (!browser.killed) browser.kill();
}

if (failure) {
  console.error(failure instanceof Error ? failure.message : String(failure));
  process.exit(1);
}

process.exit(0);
