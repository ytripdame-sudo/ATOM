/**
 * ATOM — real-browser acceptance run.
 *
 * `npm test` is two seconds and no browser; this is the opposite: it installs
 * the extension in Chromium and drives one real turn, which is the only way to
 * know the `chrome` shapes the worker uses are Chromium's rather than my reading
 * of the docs. It checks the page itself changed, not just that a message said so.
 *
 * A second turn asks for the same click and is denied: nothing reaches the page
 * and the turn still ends cleanly. A third switches Console capture on: the
 * debugger is attached for that turn, the fixture logs a line and fails a
 * request, both come back through the worker, and the session is detached when
 * the turn ends.
 *
 *   npm run accept            headless
 *   npm run accept -- --headed
 *
 * Two substitutions, printed after every run:
 *
 *  - Provider: a local OpenAI-compatible stub, because a service worker's `fetch`
 *    is not reliably routable by Playwright. The copy of the extension points at
 *    it; the source tree is never modified.
 *  - Permission: Chromium's host-permission prompt is browser UI that Playwright
 *    cannot click, so the copy's manifest already holds the fixture's origin.
 *    `permissions.contains`, the injected content script and the panel's
 *    capability state are still Chromium's answers.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headed = process.argv.includes('--headed');

let passed = 0;

function step(text) {
  passed += 1;
  console.log(`  ✓ ${text}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function until(check, message, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

/** Tool rows of a snapshot, in transcript order. */
const toolRows = (state) => state.session.messages.filter((message) => message.role === 'tool');

/** What the fixture page itself recorded about what happened to it. */
const pageState = (page) =>
  page.evaluate(() => ({
    clicks: window.__clicks || 0,
    clicked: document.body.dataset.clicked || '',
    status: document.getElementById('status')?.textContent || '',
  }));

/* ------------------------------------------------------------------ fixture */

/** The page the assistant reads and clicks. Its own script records the click. */
const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>ATOM acceptance fixture</title></head>
<body>
  <h1>Fixture checkout</h1>
  <p>This page exists so a real browser can be read and clicked.</p>
  <button id="buy" type="button">Buy now</button>
  <input id="note" name="note" placeholder="Add a note">
  <script>
    let clicks = 0;
    document.getElementById('buy').addEventListener('click', () => {
      clicks += 1;
      window.__clicks = clicks;
      document.body.dataset.clicked = 'yes';
      const status = document.createElement('p');
      status.id = 'status';
      status.textContent = 'Purchased.';
      document.body.append(status);
    });
  </script>
</body></html>`;

/* ------------------------------------------------------------ stub provider */

const sse = (frame) => `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`;

const toolCall = (name, args, id = `call_${name}`) =>
  sse({
    choices: [
      {
        delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] },
        finish_reason: 'tool_calls',
      },
    ],
  });

const text = (content) => sse({ choices: [{ delta: { content }, finish_reason: 'stop' }] });

/**
 * One server for the fixture page and the provider, on one origin, so the single
 * host permission in the copy's manifest covers both.
 */
function startStub() {
  let origin = '';
  const requests = [];
  const replies = [];

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, origin);

    if (pathname === '/' || pathname === '/next') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE);
      return;
    }

    if (pathname === '/openai/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
      return;
    }

    if (pathname === '/openai/v1/chat/completions') {
      const body = [];
      req.on('data', (piece) => body.push(piece));
      req.on('end', async () => {
        requests.push(JSON.parse(Buffer.concat(body).toString('utf8')));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // A reply may wait: the capture turn holds its first one until the page
        // has actually logged, so the tools read a buffer that is not empty.
        res.end(await (replies.shift() ?? (() => text('Done.')))());
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ origin, server, requests, replies });
    });
  });
}

/* --------------------------------------------------------------- extension */

/**
 * A copy of the extension wired to the stub. Two files change: the provider
 * origin, and a manifest that already holds the fixture's origin.
 */
async function prepareExtension(origin) {
  const dir = await mkdtemp(path.join(tmpdir(), 'atom-accept-'));
  const extension = path.join(dir, 'extension');
  await cp(path.join(root, 'extension'), extension, { recursive: true });

  const provider = path.join(extension, 'lib/providers/groq.js');
  const source = await readFile(provider, 'utf8');
  assert(source.includes('https://api.groq.com'), 'the provider origin moved; update this script');
  await writeFile(provider, source.replaceAll('https://api.groq.com', origin));

  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...manifest.host_permissions, `${origin}/*`];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // A real click on this extension page is a user gesture, so Chromium allows
  // the side panel to open through the same API the toolbar uses.
  await writeFile(
    path.join(extension, 'accept-sidepanel.html'),
    '<!doctype html><button id="open" type="button">Open ATOM</button><script src="accept-sidepanel.js"></script>',
  );
  await writeFile(
    path.join(extension, 'accept-sidepanel.js'),
    "document.getElementById('open').addEventListener('click', () => { chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }); });",
  );

  return { dir, extension };
}

/** Chromium with the copy loaded unpacked, and the id of the extension it ran. */
async function launch(extension) {
  const profile = await mkdtemp(path.join(tmpdir(), 'atom-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !headed,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });

  return { context, profile, worker, id: new URL(worker.url()).host };
}

/* -------------------------------------------------------------------- panel */

/**
 * A port from inside the panel page: the same messages its own transport sends,
 * over Chromium's real `chrome.runtime`, plus a way to await one of them.
 */
async function connect(panel) {
  await panel.evaluate(() => {
    const port = chrome.runtime.connect({ name: 'atom' });
    const received = [];
    port.onMessage.addListener((message) => received.push(message));
    window.__atom = { received, send: (message) => port.postMessage(message) };
  });

  const send = (message) => panel.evaluate((payload) => window.__atom.send(payload), message);
  const count = () => panel.evaluate(() => window.__atom.received.length);

  /**
   * Resolve with the first message at or after `from` that matches: `{ t }` for
   * a message type, or `{ kind, state?, busy? }` for an event.
   */
  const wait = (match, from = 0, timeout = 20000) =>
    panel
      .waitForFunction(
        ({ match, from }) => {
          const hit = window.__atom.received.slice(from).find((message) => {
            if (match.t) return message.t === match.t;
            const event = message.e;
            if (event?.kind !== match.kind) return false;
            if (match.state && event.state !== match.state) return false;
            if ('busy' in match && event.busy !== match.busy) return false;
            return true;
          });
          return hit ?? false;
        },
        { match, from },
        { timeout, polling: 100 },
      )
      .then((handle) => handle.jsonValue());

  /** Ask the worker for a fresh snapshot, the way the panel does on open. */
  const snapshot = async () => {
    const from = await count();
    await send({ t: 'hello' });
    return wait({ t: 'state' }, from);
  };

  return { send, count, wait, snapshot };
}

/* ---------------------------------------------------------------------- run */

async function run() {
  console.log(`ATOM acceptance — ${headed ? 'headed' : 'headless'} Chromium, stub provider, real extension`);

  const stub = await startStub();
  let releaseConsole;
  const afterCaptureAttaches = new Promise((resolve) => {
    releaseConsole = resolve;
  });
  stub.replies.push(
    () => toolCall('read_page', '{}'),
    () => toolCall('click', '{"ref":"e1"}'),
    () => text('Clicked Buy now for you.'),
    () => toolCall('click', '{"ref":"e1"}'),
    () => text('Understood — I did not click it.'),
    async () => {
      await afterCaptureAttaches;
      return toolCall('read_console', '{}');
    },
    () => toolCall('read_network', '{}'),
    () => text('The console shows the failure you asked for.'),
  );
  step(`stub provider and fixture page on ${stub.origin}`);

  const prepared = await prepareExtension(stub.origin);
  step('extension copied with the provider pointed at the stub');

  const { context, profile, worker, id } = await launch(prepared.extension);
  step(`extension running in Chromium (${id})`);

  try {
    const fixture = await context.newPage();
    await fixture.goto(`${stub.origin}/`);

    // The panel is an extension page; in a tab it has the same runtime API the
    // side panel has, including its own port.
    const panel = await context.newPage();
    // A panel error is invisible in a headless run; surface it instead.
    panel.on('pageerror', (error) => console.log(`PANEL ERROR — ${error.message}`));
    panel.on('console', (message) => {
      if (message.type() === 'error') console.log(`PANEL CONSOLE — ${message.text()}`);
    });
    await panel.goto(`chrome-extension://${id}/sidepanel/index.html`);
    const atom = await connect(panel);
    step('fixture page and panel page loaded, panel connected over chrome.runtime');

    // The worker answers "active tab" with the focused tab, so the page under
    // test has to be in front, not the panel.
    await fixture.bringToFront();
    const initial = await atom.snapshot();
    assert(initial.capabilities.pageAccess === true, 'page access is not granted for the fixture origin');
    assert(initial.capabilities.host === new URL(stub.origin).host, `capabilities host: ${initial.capabilities.host}`);
    assert(initial.settings.hasKey === false, 'a key was present before one was set');
    step('capabilities report the granted fixture origin, and there is no key yet');

    // The panel's UI is driven by its own port: with no key it says so.
    await panel.waitForFunction(() => document.getElementById('setup')?.hidden === false, null, { timeout: 10000 });
    step('panel UI shows its setup card while no key is saved');

    const askHiddenBeforeKey = await panel.evaluate(() => document.getElementById('accessAsk').hidden);
    assert(askHiddenBeforeKey === true, 'the access card showed before there was a key');

    // Chromium's prompt cannot be clicked from here, so the grant is pre-seeded;
    // the request API is still Chromium's, and answers true without a prompt.
    const granted = await panel.evaluate(async (origin) => {
      const already = await chrome.permissions.contains({ origins: [origin] });
      const requested = await chrome.permissions.request({ origins: [origin] });
      return { already, requested };
    }, `${stub.origin}/*`);
    assert(granted.already && granted.requested, `permissions: ${JSON.stringify(granted)}`);
    step('permissions.contains and permissions.request both answer true');

    // Settings: the worker verifies the key against the stub itself.
    const beforeKey = await atom.count();
    await atom.send({ t: 'settings.update', patch: { apiKey: 'gsk_acceptance_stub' } });
    await atom.wait({ kind: 'keycheck', state: 'ok' }, beforeKey);
    step('key saved and verified against the stub provider');

    // The key list: one line per key, with the status the worker reports.
    const keyLine = await panel.evaluate(() => {
      const item = document.querySelector('#groqKeys .key-item');
      return item ? { state: item.dataset.state || '', dots: item.querySelectorAll('.key-item__dot').length } : null;
    });
    assert(keyLine && keyLine.dots === 1, `key line not drawn: ${JSON.stringify(keyLine)}`);
    step('the saved key is listed with its live status');

    await panel.waitForFunction(() => document.getElementById('setup')?.hidden === true, null, { timeout: 10000 });
    step('panel UI dropped the setup card once the key checked out');

    // The one-time ask: offered once there is a key, answered once, then gone.
    await panel.waitForFunction(() => document.getElementById('accessAsk')?.hidden === false, null, { timeout: 10000 });
    step('the welcome screen asked once about site access');

    const beforeAsk = await atom.count();
    await panel.click('#accessPerSite');
    const saved = await atom.wait({ kind: 'settings' }, beforeAsk);
    assert(saved.e.settings.accessChoice === 'per-site', `accessChoice: ${saved.e.settings.accessChoice}`);
    await panel.waitForFunction(() => document.getElementById('accessAsk')?.hidden === true, null, { timeout: 10000 });

    // A second panel reads the same answer out of storage: no second ask.
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${id}/sidepanel/index.html`);
    const askedAgain = await reopened
      .waitForFunction(() => document.getElementById('accessAsk')?.hidden === false, null, { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    assert(!askedAgain, 'the access card came back in a new panel');
    await reopened.close();
    await fixture.bringToFront();
    step('the answer stuck: a second panel did not ask again');

    // The page was read locally when the panel opened: the row says so, and it
    // claims no model step.
    await panel.waitForSelector('#context:not([hidden])', { timeout: 10000 });
    const contextText = await panel.textContent('#contextText');
    const fixtureHost = new URL(stub.origin).host;
    assert(contextText.includes(fixtureHost) && /element/i.test(contextText), `context row: ${contextText}`);
    const contextTag = await panel.textContent('.context__tag');
    assert(contextTag === 'local', `context tag: ${contextTag}`);
    step(`the digest row is shown locally (${contextText})`);

    // One turn: read the page, click e1, answer. The model is scripted.
    await fixture.bringToFront();
    const beforeTurn = await atom.count();
    await atom.send({ t: 'chat.send', text: 'read this page and buy it' });

    const card = await atom.wait({ kind: 'confirm' }, beforeTurn);
    assert(/^Click “Buy now”$/.test(card.e.request.summary), `confirm summary: ${card.e.request.summary}`);
    assert(card.e.request.host === new URL(stub.origin).host, `confirm host: ${card.e.request.host}`);
    step(`confirmation card for "${card.e.request.summary}" on the fixture's host`);

    // A click here can be remembered, and the panel is what records it.
    assert(
      card.e.request.grant?.kind === 'click' && card.e.request.grant?.host === fixtureHost,
      `grant offer: ${JSON.stringify(card.e.request.grant)}`,
    );

    await panel.waitForSelector(`.confirm[data-id='${card.e.request.id}']`, { timeout: 10000 });
    const grantCopy = await panel.textContent('.confirm__grant');
    assert(/Don't ask again for clicking on/.test(grantCopy), `grant copy: ${grantCopy}`);
    // DOM clicks: the panel page in this run is not tall enough to scroll the
    // card into the viewport, and Playwright refuses to click off-screen.
    const answered = await panel.evaluate((id) => {
      const card = document.querySelector(`.confirm[data-id='${id}']`);
      if (!card) return 'no card';
      const box = card.querySelector('.confirm__grant input');
      if (!box) return 'no offer';
      if (!box.checked) box.click();
      const allow = card.querySelector('.btn--primary');
      if (!allow) return 'no allow';
      allow.click();
      return 'answered';
    }, card.e.request.id);
    assert(answered === 'answered', `panel card: ${answered}`);
    await atom.wait({ kind: 'busy', busy: false }, beforeTurn, 40000);
    step('the panel recorded a remembered click');

    // Settings lists the grant, and revoking it takes it back.
    const grantRow = await panel.textContent('#grants');
    assert(grantRow.includes(fixtureHost) && /clicking/.test(grantRow), `trusted row: ${grantRow}`);
    const revoked = await panel.evaluate(() => {
      const button = document.querySelector('#grants .btn--small');
      if (!button) return false;
      button.click();
      return true;
    });
    assert(revoked, 'the revoke button was not rendered');
    await panel.waitForSelector('#grantsEmpty:not([hidden])', { timeout: 5000 });
    step('revoking in Settings removed the grant');

    await atom.wait({ kind: 'busy', busy: false }, beforeTurn, 40000);
    step('turn finished after the click was allowed');

    // What the turn cost, on the answer: steps exact, tokens estimated.
    await panel.waitForSelector('.msg__meta', { timeout: 5000 });
    const turnMeta = await panel.textContent('.msg__meta');
    assert(/\d+ steps?/.test(turnMeta) && /~[\d.]+k? tokens/.test(turnMeta), `turn meta: ${turnMeta}`);
    step(`the turn says what it cost (${turnMeta})`);

    // The toolset the real worker offered, and the prompt that describes it.
    const turnTools = (stub.requests.at(-1)?.tools ?? []).map((tool) => tool.function.name);
    assert(
      ['read_page', 'click', 'navigate', 'web_search', 'show_image'].every((name) => turnTools.includes(name)),
      `tools offered: ${turnTools.join(', ')}`,
    );
    const system = (stub.requests.at(-1)?.messages ?? []).find((message) => message.role === 'system')?.content ?? '';
    assert(/Web lookups: web_search/.test(system), 'the prompt does not mention the web tools');
    const firstSystem = (stub.requests[0]?.messages ?? []).find((message) => message.role === 'system')?.content ?? '';
    assert(/ATOM_UNTRUSTED:PAGE_DIGEST/.test(firstSystem), 'the first request did not carry the page digest');
    assert(!/PAGE_DIGEST/.test(system), 'the digest was repeated on a later step');
    step('the turn offered page tools, navigation and web lookups, and the prompt described them');

    // The browsing agent is off until asked for, and the task card stays away
    // while it is off.
    const agentUi = await panel.evaluate(() => ({
      hidden: document.getElementById('task').hidden,
      modes: [...document.querySelectorAll('#agentMode button')].map((button) => button.dataset.agent),
      selected: document.querySelector('#agentMode button[aria-selected="true"]')?.dataset.agent,
    }));
    assert(agentUi.modes.join(',') === 'off,ask,playground', `agent modes: ${agentUi.modes}`);
    assert(agentUi.selected === 'off', `default mode: ${agentUi.selected}`);
    assert(agentUi.hidden, 'the task card showed while the agent was off');
    step('the browser agent is off by default, with a task card that stays out of the way');

    const beforeAgentMode = await atom.count();
    await atom.send({
      t: 'settings.update',
      patch: { agent: { mode: 'playground', stepLimit: 8, trustedSites: ['example.com'] } },
    });
    await atom.wait({ kind: 'settings' }, beforeAgentMode);
    const agentSaved = await atom.snapshot();
    assert(agentSaved.settings.agent.mode === 'playground', `agent mode: ${agentSaved.settings.agent.mode}`);
    assert(agentSaved.settings.agent.trustedSites[0] === 'example.com');
    await panel.waitForFunction(
      () => document.querySelector('#agentMode button[aria-selected="true"]')?.dataset.agent === 'playground',
      null,
      { timeout: 5000 },
    );
    step('agent mode, step limit and trusted sites round-trip through settings and the panel');

    // Leave the rest of the run as it was: the chat assistant, agent off.
    const beforeAgentReset = await atom.count();
    await atom.send({ t: 'settings.update', patch: { agent: { mode: 'off', stepLimit: 16, trustedSites: [] } } });
    await atom.wait({ kind: 'settings' }, beforeAgentReset);

    const final = await atom.snapshot();
    const read = toolRows(final).find((row) => row.tool.name === 'read_page');
    const clicked = toolRows(final).find((row) => row.tool.name === 'click');
    assert(read?.tool.status === 'done', `read row: ${JSON.stringify(read?.tool)}`);
    assert(/\[e1\] button "Buy now"/.test(read.text), `read row text: ${read.text?.slice(0, 200)}`);
    assert(clicked?.tool.status === 'done' && /Clicked/.test(clicked.tool.detail), `click row: ${JSON.stringify(clicked?.tool)}`);
    step('read_page described the real page and the click settled as done');

    // The page is the witness: the click happened, and its handler's update is
    // on screen — a message saying "clicked" would not prove this.
    const witness = await pageState(fixture);
    assert(
      witness.clicked === 'yes' && witness.status === 'Purchased.' && witness.clicks === 1,
      `page witness: ${JSON.stringify(witness)}`,
    );
    step('the page ran its own click handler ("Purchased." appeared)');

    // And the loop closed: the tools were offered, and both results came back
    // fenced in the request that followed them, before the final answer.
    const offered = (stub.requests[0].tools || []).map((tool) => tool.function.name);
    assert(offered.includes('read_page') && offered.includes('click'), `tools offered: ${offered.join(', ')}`);
    const followUp = stub.requests.at(-1);
    const fenced = (name) =>
      followUp.messages.some((message) => message.role === 'tool' && message.content.includes(`<<<ATOM_UNTRUSTED:${name}>>>`));
    assert(fenced('READ_PAGE'), 'the read result was not sent back fenced');
    assert(followUp.messages.some((message) => message.role === 'tool' && /Clicked/.test(message.content)), 'the click result was not sent back');
    step('provider saw the page tools and both fenced tool results');

    // Second turn: the same click, denied. Nothing should reach the page, and
    // the turn must still end cleanly rather than hanging on the question.
    await fixture.bringToFront();
    const beforeDenial = await atom.count();
    await atom.send({ t: 'chat.send', text: 'buy it again' });

    const deniedCard = await atom.wait({ kind: 'confirm' }, beforeDenial);
    assert(/^Click “Buy now”$/.test(deniedCard.e.request.summary), `denied card: ${deniedCard.e.request.summary}`);
    await atom.send({ t: 'confirm.respond', id: deniedCard.e.request.id, allow: false });
    await atom.wait({ kind: 'busy', busy: false }, beforeDenial, 40000);

    const afterDenial = await atom.snapshot();
    const deniedRow = toolRows(afterDenial).filter((row) => row.tool.name === 'click').at(-1);
    assert(
      deniedRow?.tool.status === 'denied' && /denied/i.test(deniedRow.text),
      `denied row: ${JSON.stringify(deniedRow?.tool)}`,
    );
    assert(
      afterDenial.busy === false && !afterDenial.session.messages.some((row) => row.status === 'error'),
      'the turn did not finish cleanly',
    );

    // The page is the witness again: its handler has still run exactly once.
    const afterClicks = await pageState(fixture);
    assert(afterClicks.clicks === 1, `the page's click handler ran ${afterClicks.clicks} time(s)`);

    // And the denial reached the model, so the turn closed the loop rather than
    // stalling on the question.
    assert(
      stub.requests.some((request) => request.messages.some((row) => row.role === 'tool' && /denied/i.test(row.content))),
      'the denial was not sent back to the model',
    );
    step('a denied click never reached the page, and the turn still finished cleanly');

    // Third turn, with Console capture on. The debugger attaches for the turn
    // and the panel is told before the first request goes out.
    const beforeCapture = await atom.count();
    await fixture.bringToFront();
    await atom.send({ t: 'chat.send', text: 'what just failed?', capture: true });

    const attached = await atom.wait({ kind: 'capture' }, beforeCapture);
    assert(attached.e.attached === true, `capture event: ${JSON.stringify(attached.e)}`);
    step('capture attached for the turn, and the panel was told');

    const failed = await fixture.evaluate(async () => {
      console.error('[fixture] acceptance console line');
      const response = await fetch('/missing');
      return response.status;
    });
    assert(failed === 404, `fixture request status: ${failed}`);
    // Let the CDP events land before the worker's tools read the buffers.
    await new Promise((resolve) => setTimeout(resolve, 150));
    releaseConsole();

    await atom.wait({ kind: 'busy', busy: false }, beforeCapture, 40000);
    step('the capture turn finished');

    const after = await atom.snapshot();
    const rows = toolRows(after);
    const consoleRow = rows.find((row) => row.tool.name === 'read_console');
    const networkRow = rows.find((row) => row.tool.name === 'read_network');
    assert(consoleRow?.tool.status === 'done', `console row: ${JSON.stringify(consoleRow?.tool)}`);
    assert(/acceptance console line/.test(consoleRow.text), `console text: ${consoleRow.text?.slice(0, 300)}`);
    assert(networkRow?.tool.status === 'done', `network row: ${JSON.stringify(networkRow?.tool)}`);
    assert(/\/missing/.test(networkRow.text) && /404/.test(networkRow.text), `network text: ${networkRow.text?.slice(0, 300)}`);
    step("read_console and read_network returned the page's own error and its 404");

    assert(after.capture.attached === false, 'the debugger is still attached');
    const closed = await panel.evaluate(() =>
      window.__atom.received.some((message) => message.e?.kind === 'capture' && message.e.attached === false),
    );
    assert(closed, 'the panel was never told the session closed');
    step('debugger detached when the turn ended, and the panel was told');

    // The capture tools exist only while a session is attached: they show up in
    // the attached turn's requests, and never in the run's first request.
    const captureRequest = stub.requests.find((request) =>
      (request.tools || []).some((tool) => tool.function.name === 'read_console'),
    );
    const captureNames = (captureRequest?.tools || []).map((tool) => tool.function.name);
    assert(captureNames.includes('read_network'), `capture tools: ${captureNames.join(', ')}`);
    assert(
      !(stub.requests[0].tools || []).some((tool) => tool.function.name === 'read_console'),
      'capture tools were offered without a session',
    );
    step('capture tools offered only while a session was attached');

    const beforeShotMode = await atom.count();
    await atom.send({ t: 'settings.update', patch: { agent: { mode: 'playground', stepLimit: 8, trustedSites: [] } } });
    await atom.wait({ kind: 'settings' }, beforeShotMode);
    stub.replies.push(
      () => toolCall('screenshot', '{"tab":null}', 'call_screenshot'),
      () => text('Captured the fixture.'),
    );
    await fixture.bringToFront();
    const beforeShot = await atom.count();
    await atom.send({ t: 'chat.send', text: 'show me this page' });
    await atom.wait({ kind: 'busy', busy: false }, beforeShot, 40000);
    const shotRow = toolRows(await atom.snapshot())
      .filter((row) => row.tool.name === 'screenshot')
      .at(-1);
    assert(shotRow?.tool.status === 'done', `screenshot row: ${JSON.stringify(shotRow?.tool)}`);
    const shotPreview = await panel.evaluate((from) => {
      const hit = window.__atom.received
        .slice(from)
        .find((message) => message.e?.kind === 'toolUpdate' && String(message.e.tool?.preview || '').startsWith('data:image/png;base64,'));
      return hit?.e?.tool?.preview || '';
    }, beforeShot);
    assert(shotPreview, 'the screenshot preview is missing');
    step('a screenshot with a null tab captured the tab and produced a preview');

    assert(stub.replies.length === 0, `the task replies would follow ${stub.replies.length} queued reply(s)`);
    const beforeTaskMode = await atom.count();
    await atom.send({ t: 'settings.update', patch: { agent: { mode: 'playground', stepLimit: 8, trustedSites: [] } } });
    await atom.wait({ kind: 'settings' }, beforeTaskMode);

    let releasePaused;
    const pausedReply = new Promise((resolve) => {
      releasePaused = resolve;
    });
    let releaseStopped;
    const stoppedReply = new Promise((resolve) => {
      releaseStopped = resolve;
    });
    stub.replies.push(
      () =>
        toolCall(
          'plan',
          JSON.stringify({ steps: ['Read the fixture page', 'Check the browser history', 'Report back'] }),
          'call_task_plan',
        ),
      () => toolCall('read_page', '{}', 'call_task_read_1'),
      async () => {
        await pausedReply;
        return toolCall('browser', JSON.stringify({ action: 'history', query: 'fixture' }), 'call_task_history');
      },
      async () => {
        await stoppedReply;
        return text('The task finished.');
      },
    );

    const taskRequests = stub.requests.length;
    await fixture.bringToFront();
    const beforeTask = await atom.count();
    await atom.send({ t: 'chat.send', text: 'check the fixture in two steps' });

    await panel.waitForFunction(
      () =>
        !document.getElementById('task').hidden &&
        document.querySelectorAll('#taskPlan li').length === 3 &&
        document.querySelectorAll('#taskLog .task__entry[data-status="done"]').length === 1,
      null,
      { timeout: 10000 },
    );
    const taskCard = await panel.evaluate(() => ({
      phase: document.getElementById('task').dataset.phase,
      title: document.getElementById('taskTitle').textContent,
      plan: [...document.querySelectorAll('#taskPlan li')].map((item) => item.textContent),
      log: [...document.querySelectorAll('#taskLog .task__entry')].map((row) => ({
        text: row.textContent,
        status: row.dataset.status,
      })),
    }));
    assert(taskCard.phase === 'running', `task phase: ${taskCard.phase}`);
    assert(taskCard.title === 'ATOM is controlling this tab', `task title: ${taskCard.title}`);
    assert(
      taskCard.plan.join('|') === 'Read the fixture page|Check the browser history|Report back',
      `task plan: ${taskCard.plan.join('|')}`,
    );
    assert(taskCard.log[0]?.status === 'done' && /read/i.test(taskCard.log[0].text), `task log: ${JSON.stringify(taskCard.log)}`);
    step('a real plan task shows its card, plan and first completed log entry');

    await panel.evaluate(() => document.getElementById('taskPause').click());
    await panel.waitForFunction(() => document.getElementById('task').dataset.phase === 'paused', null, { timeout: 5000 });
    const pausedTask = await atom.snapshot();
    assert(
      pausedTask.task?.phase === 'paused' && pausedTask.busy === true,
      `paused state: ${JSON.stringify({ phase: pausedTask.task?.phase, busy: pausedTask.busy })}`,
    );
    assert(await panel.evaluate(() => !document.getElementById('taskResume').hidden), 'Resume was not offered');
    releasePaused();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const afterPause = await panel.evaluate(() => ({
      phase: document.getElementById('task').dataset.phase,
      log: document.querySelectorAll('#taskLog .task__entry').length,
    }));
    assert(afterPause.phase === 'paused' && afterPause.log === 1, `the task advanced while paused: ${JSON.stringify(afterPause)}`);
    step('pause held the next step; the task card says so');

    await panel.evaluate(() => document.getElementById('taskResume').click());
    await panel
      .waitForFunction(
        () =>
          document.getElementById('task').dataset.phase === 'running' &&
          document.querySelectorAll('#taskLog .task__entry').length === 2,
        null,
        { timeout: 10000 },
      )
      .catch(async (error) => {
        const state = await panel.evaluate(() => ({
          phase: document.getElementById('task').dataset.phase,
          title: document.getElementById('taskTitle').textContent,
          log: [...document.querySelectorAll('#taskLog .task__entry')].map((row) => ({
            text: row.textContent,
            status: row.dataset.status,
          })),
        }));
        throw new Error(`${error.message} — task=${JSON.stringify(state)}`);
      });
    const resumedTask = await panel.evaluate(() => ({
      phase: document.getElementById('task').dataset.phase,
      log: [...document.querySelectorAll('#taskLog .task__entry')].map((row) => ({
        text: row.textContent,
        status: row.dataset.status,
      })),
    }));
    assert(resumedTask.phase === 'running' && resumedTask.log.length === 2, `resumed task: ${JSON.stringify(resumedTask)}`);
    assert(resumedTask.log.every((entry) => entry.status === 'done'), `resumed log: ${JSON.stringify(resumedTask.log)}`);
    step('resume ran the held step and the log grew to two');

    const taskDeadline = Date.now() + 10000;
    while (stub.requests.length < taskRequests + 4) {
      if (Date.now() > taskDeadline) throw new Error('the task did not ask for another step after resume');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const requestsAtStop = stub.requests.length;
    await panel.evaluate(() => document.getElementById('taskStop').click());
    await atom.wait({ kind: 'busy', busy: false }, beforeTask, 40000);
    await panel.waitForFunction(() => document.getElementById('task').dataset.phase === 'stopped', null, { timeout: 5000 });
    releaseStopped();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert(stub.requests.length === requestsAtStop, `stop sent another request: ${stub.requests.length - requestsAtStop}`);
    const stoppedTask = await panel.evaluate(() => ({
      phase: document.getElementById('task').dataset.phase,
      title: document.getElementById('taskTitle').textContent,
      log: document.querySelectorAll('#taskLog .task__entry').length,
      stopDisabled: document.getElementById('taskStop').disabled,
    }));
    assert(stoppedTask.phase === 'stopped' && stoppedTask.title === 'Task stopped', `stopped task: ${JSON.stringify(stoppedTask)}`);
    assert(stoppedTask.log === 2 && stoppedTask.stopDisabled, `stopped log/buttons: ${JSON.stringify(stoppedTask)}`);
    step('stop ended the task, kept its log, disabled its controls and sent nothing more');

    const beforeTaskReset = await atom.count();
    await atom.send({ t: 'settings.update', patch: { agent: { mode: 'off', stepLimit: 16, trustedSites: [] } } });
    await atom.wait({ kind: 'settings' }, beforeTaskReset);
    const beforeDismiss = await atom.count();
    await atom.send({ t: 'agent.dismiss' });
    const dismissed = await atom.wait({ kind: 'task' }, beforeDismiss);
    assert(dismissed.e.task === null, `task was not dismissed: ${JSON.stringify(dismissed.e.task)}`);
    await panel.waitForFunction(() => document.getElementById('task').hidden === true, null, { timeout: 5000 });

    // Conversations: a second one starts empty; the first comes back whole.
    await panel.evaluate(() => document.getElementById('newChat').click());
    await panel.waitForFunction(() => document.querySelectorAll('#chats .chat').length === 2, null, {
      timeout: 10000,
    }).catch(async (error) => {
      const state = await panel.evaluate(() => ({
        rows: document.querySelectorAll('#chats .chat').length,
        chats: document.getElementById('chats')?.outerHTML,
        title: document.getElementById('title')?.textContent,
      }));
      throw new Error(`${error.message} — chats=${state.rows} title=${state.title} html=${state.chats}`);
    });
    const chatTitles = await panel.textContent('#chats');
    assert(chatTitles.includes('read this page and buy it'), `chat list: ${chatTitles}`);

    await panel.evaluate(() => {
      const row = [...document.querySelectorAll('#chats .chat')].find((entry) => !entry.classList.contains('is-open'));
      row?.querySelector('.chat__open')?.click();
    });
    await panel.waitForFunction(
      () => document.querySelector('#msgs')?.textContent.includes('Clicked Buy now for you.'),
      null,
      { timeout: 10000 },
    );
    step('a second conversation, then the first one back with its answer');

    // History drawer: recency groups, and the right-click menu does the work.
    await panel.click('#historyToggle');
    await panel.waitForSelector('#side.is-open', { timeout: 5000 });
    const historyRows = await panel.locator('#sideList .side__chat').count();
    assert(historyRows >= 2, `history rows: ${historyRows}`);
    const historyText = await panel.textContent('#sideList');
    assert(/Today|Pinned/.test(historyText), `no recency group: ${historyText}`);
    step('the history drawer lists conversations in recency groups');

    await panel.locator('#sideList .side__chat').first().click({ button: 'right' });
    await panel.waitForSelector('#menu:not([hidden])', { timeout: 5000 });
    await panel.locator('#menu .menu__item', { hasText: 'Pin to top' }).click();
    await panel.waitForFunction(
      () => document.querySelector('#sideList .side__group')?.textContent === 'Pinned',
      null,
      { timeout: 5000 },
    );
    step('right-click pins a conversation into the Pinned group');

    await panel.locator('#sideList .side__chat').first().click({ button: 'right' });
    await panel.locator('#menu .menu__item', { hasText: 'Rename' }).click();
    await panel.locator('.side__rename').fill('Renamed from the menu');
    await panel.locator('.side__rename').press('Enter');
    await panel.waitForFunction(() => document.querySelector('#sideList')?.textContent.includes('Renamed from the menu'), null, {
      timeout: 5000,
    });
    const savedTitle = await panel.evaluate(async () => {
      const shelf = (await chrome.storage.local.get('atom.chats'))['atom.chats'].chats;
      return shelf.some((chat) => chat.title === 'Renamed from the menu' && chat.pinned === true);
    });
    assert(savedTitle, 'the rename and the pin were not written to storage');
    step('right-click renames a conversation, and rename and pin reach storage');
    await panel.click('#sideClose');

    // Deep think and web search: per-message switches in the composer, with an
    // honest cost estimate, and the effort reaching the provider's request.
    await panel.evaluate(() => {
      document.getElementById('deepThink').click();
      document.getElementById('webSearch').click();
    });
    const costHint = await panel.textContent('#costHint');
    assert(/effort/.test(costHint) && /tokens/.test(costHint), `cost hint: ${costHint}`);
    assert(
      await panel.evaluate(() => document.getElementById('effort').hidden === false),
      'the effort picker is hidden',
    );

    // The web switch is checked and then turned off again: sending with it on
    // would call the real search provider, which is not what this run tests.
    await panel.evaluate(() => document.getElementById('webSearch').click());
    await panel.evaluate(() => {
      const input = document.getElementById('input');
      input.value = 'explain why the sky is blue';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const beforeThink = await atom.count();
    await panel.evaluate(() => document.getElementById('composer').requestSubmit());
    await atom.wait({ kind: 'busy', busy: false }, beforeThink, 40000);

    const thinkRequest = stub.requests.at(-1);
    assert(thinkRequest.reasoning_effort === 'medium', 'deep think never reached the provider');
    const thinkPrompt = (thinkRequest.messages || []).find((message) => message.role === 'system')?.content ?? '';
    assert(/Deep think/.test(thinkPrompt), 'the deep-think directive is missing from the prompt');
    await panel.waitForFunction(
      () => document.getElementById('deepThink').getAttribute('aria-pressed') === 'false',
      null,
      { timeout: 5000 },
    );
    step('deep think reaches the provider as an effort and clears after the message');

    // Memory: added in Settings, stored by the worker, and sent in the prompt.
    await panel.evaluate(() => {
      const input = document.getElementById('memoryInput');
      input.value = 'Prefers short answers';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('memoryAdd').click();
    });
    await panel.waitForFunction(() => document.querySelectorAll('#memories .memory').length === 1, null, {
      timeout: 5000,
    });
    const memoryRow = await panel.textContent('#memories');
    assert(/Prefers short answers/.test(memoryRow), `memory row: ${memoryRow}`);

    const beforeMemoryTurn = await atom.count();
    await atom.send({ t: 'chat.send', text: 'hello again' });
    await atom.wait({ kind: 'busy', busy: false }, beforeMemoryTurn, 40000);
    const memorySystem = (stub.requests.at(-1)?.messages ?? []).find((message) => message.role === 'system')?.content ?? '';
    assert(/Prefers short answers/.test(memorySystem), 'memory did not reach the prompt');
    step('the next request carried the remembered fact');

    // Editing a question in place: the new wording is what gets answered, and
    // the old answer goes with the old wording.
    await panel.locator('.msg--user').last().hover();
    await panel.locator('.msg--user .act', { hasText: 'Edit' }).last().click();
    await panel.locator('.edit__input').fill('hello once more');
    const beforeEditTurn = await atom.count();
    await panel.locator('.edit__row .btn--primary').click();
    await atom.wait({ kind: 'busy', busy: false }, beforeEditTurn, 40000);
    const editedQuestion = (stub.requests.at(-1)?.messages ?? [])
      .filter((message) => message.role === 'user')
      .at(-1)?.content;
    assert(editedQuestion === 'hello once more', `edited question reached the provider as: ${editedQuestion}`);
    step('an edited question is the one that gets answered');

    // New Tab is the assistant itself now: it frames the panel, which connects
    // over chrome.runtime and gets the conversation like any other panel.
    const newTab = await context.newPage();
    await newTab.goto(`chrome-extension://${id}/newtab/index.html`);
    const framed = newTab.frameLocator('iframe');
    await framed.locator('.msg').first().waitFor({ timeout: 20000 });
    await framed.locator('#composer').waitFor({ timeout: 5000 });
    assert(
      newTab.frames().some((frame) => frame.url().includes('/sidepanel/index.html')),
      `the new tab frames: ${newTab.frames().map((frame) => frame.url()).join(' ')}`,
    );
    // The start page's theme comes from Settings and follows it live.
    const beforeTheme = await atom.count();
    await atom.send({ t: 'settings.update', patch: { startpage: { background: 'nebula', clock: false } } });
    await atom.wait({ kind: 'settings' }, beforeTheme);
    await newTab.waitForFunction(() => document.body.dataset.background === 'nebula', null, { timeout: 10000 });
    const clockHidden = await newTab.evaluate(() => document.getElementById('clock').hidden);
    assert(clockHidden, 'the clock switch did not reach the start page');

    // The wallpaper engine: the picker lists the built-ins, picking one paints a
    // canvas in the front layer, and the choice survives a reload of the record.
    await newTab.evaluate(() => document.getElementById('wallBtn').click());
    const presetTile = newTab.locator('.walltile[data-id="preset:blobs"]');
    await presetTile.waitFor({ timeout: 10000 });
    await presetTile.click();
    await newTab.waitForFunction(() => document.querySelector('.wall__layer.is-in canvas') !== null, null, {
      timeout: 10000,
    });
    const wallpaper = await newTab.evaluate(async () => (await chrome.storage.local.get('atom.wallpapers'))['atom.wallpapers']);
    assert(wallpaper?.activeId === 'preset:blobs', `wallpaper not remembered: ${JSON.stringify(wallpaper)}`);
    assert(
      ['flow', 'blobs', 'particles'].includes(wallpaper.activeId.split(':')[1]),
      `unexpected preset: ${wallpaper.activeId}`,
    );
    step('the wallpaper picker paints a built-in preset on a canvas and remembers the choice');

    // Custom HTML wallpapers run in a manifest sandbox page: a wallpaper's own
    // inline script has to execute there, which is the point of that split.
    const sandboxed = await newTab.evaluate(async () => {
      const frame = document.createElement('iframe');
      frame.style.display = 'none';
      frame.addEventListener(
        'load',
        () => {
          frame.contentWindow.postMessage(
            { type: 'atom-wall-html', html: '<script>parent.postMessage({type:"atom-wall-ran"},"*")<' + '/script>' },
            '*',
          );
        },
        { once: true },
      );
      const ran = new Promise((resolve) => {
        const onMessage = (event) => {
          if (event.data?.type !== 'atom-wall-ran') return;
          removeEventListener('message', onMessage);
          resolve(true);
        };
        addEventListener('message', onMessage);
        setTimeout(() => resolve(false), 4000);
      });
      frame.src = chrome.runtime.getURL('newtab/wall-frame.html');
      document.body.append(frame);
      const result = await ran;
      frame.remove();
      return result;
    });
    assert(sandboxed, 'a custom HTML wallpaper could not run its own script');
    step('a custom HTML wallpaper runs its own script inside the wall sandbox');

    // Import: the file lands in IndexedDB, gets a tile, and comes back out again.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await newTab.setInputFiles('#wallFiles', { name: 'test-wall.png', mimeType: 'image/png', buffer: png });
    await newTab.waitForFunction(() => document.querySelectorAll('.walltile[data-kind="image"]').length === 1, null, {
      timeout: 10000,
    });
    const storedFile = await newTab.evaluate(async () => {
      const record = (await chrome.storage.local.get('atom.wallpapers'))['atom.wallpapers'];
      if (!record?.items?.length) return { items: 0, size: -1 };
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('atom-wallpapers', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const blob = await new Promise((resolve, reject) => {
        const request = database.transaction('files').objectStore('files').get(record.items[0].id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return { items: record.items.length, size: blob instanceof Blob ? blob.size : -1 };
    });
    assert(storedFile.items === 1, `wallpaper not recorded: ${JSON.stringify(storedFile)}`);
    assert(storedFile.size === png.length, `the file is not in IndexedDB: ${storedFile.size} bytes`);

    await newTab.locator('.walltile[data-kind="image"] .walltile__x').click({ force: true });
    await newTab.waitForFunction(() => document.querySelectorAll('.walltile[data-kind="image"]').length === 0, null, {
      timeout: 10000,
    });
    const cleared = await newTab.evaluate(async () => (await chrome.storage.local.get('atom.wallpapers'))['atom.wallpapers']);
    assert(cleared.items.length === 0, 'the removed wallpaper is still listed');
    step('a local image is stored in IndexedDB, listed as a tile, and removed cleanly');

    // Erase: two clicks, and the transcripts are gone from storage rather than
    // hidden from the list.
    const shelfBefore = await panel.evaluate(async () => {
      const shelf = (await chrome.storage.local.get('atom.chats'))?.['atom.chats']?.chats ?? [];
      return shelf.length;
    });
    assert(shelfBefore > 1, `expected several conversations, saw ${shelfBefore}`);
    await panel.evaluate(() => document.getElementById('eraseChats').click());
    await panel.evaluate(() => document.getElementById('eraseChats').click());
    await panel.waitForFunction(() => document.querySelectorAll('#chats .chat').length === 1, null, { timeout: 5000 });
    const erased = await panel.evaluate(async () => {
      const shelf = (await chrome.storage.local.get('atom.chats'))?.['atom.chats']?.chats ?? [];
      const settings = (await chrome.storage.local.get('atom.settings'))?.['atom.settings'] ?? {};
      return {
        chats: shelf.length,
        messages: shelf[0]?.messages?.length ?? -1,
        memories: settings.memories?.length ?? -1,
        legacy: (await chrome.storage.local.get('atom.session'))?.['atom.session'],
      };
    });
    assert(erased.chats === 1 && erased.messages === 0, `chat erasure: ${JSON.stringify(erased)}`);
    assert(erased.memories === 1, 'erasing conversations must not touch memories');
    assert(!erased.legacy, 'the old single-session key survived the erase');
    step('erasing conversations leaves one empty chat and no transcript in storage');

    await panel.evaluate(() => document.getElementById('eraseMemories').click());
    await panel.evaluate(() => document.getElementById('eraseMemories').click());
    await panel.waitForFunction(() => document.querySelectorAll('#memories .memory').length === 0, null, { timeout: 5000 });
    const memoriesLeft = await panel.evaluate(
      async () => ((await chrome.storage.local.get('atom.settings'))?.['atom.settings']?.memories ?? []).length,
    );
    assert(memoriesLeft === 0, `memories left in storage: ${memoriesLeft}`);
    step('forgetting all memories deletes the stored facts');

    // Graphics mode: performance turns motion off on every surface and keeps the
    // states — colours, key status, layout — exactly as they were.
    await panel.evaluate(() => window.atomPerf.set('performance'));
    await newTab.waitForFunction(() => document.documentElement.dataset.perf === 'performance', null, {
      timeout: 10000,
    });
    const still = await panel.evaluate(() => {
      const button = document.querySelector('.btn');
      const ring = document.querySelector('.mark[data-spin] .mark__ring--a') || document.body;
      const dot = document.querySelector('.key-item[data-state] .key-item__dot');
      return {
        transition: getComputedStyle(button).transitionDuration,
        animation: getComputedStyle(ring).animationName,
        glow: getComputedStyle(document.querySelector('.app'), '::before').display,
        dot: dot ? getComputedStyle(dot).backgroundColor : 'missing',
      };
    });
    assert(still.transition.split(',').every((value) => value.trim() === '0s'), `transitions still run: ${still.transition}`);
    assert(still.animation === 'none', `the mark still spins: ${still.animation}`);
    assert(still.glow === 'none', `decorative glow still painted: ${still.glow}`);
    assert(still.dot !== 'missing' && still.dot !== 'rgba(0, 0, 0, 0)', `key status colour lost: ${still.dot}`);
    step('performance mode stops transitions, animations and decorative glows, and keeps key status colours');

    const frames = await newTab.evaluate(async () => {
      let count = 0;
      const original = window.requestAnimationFrame;
      window.requestAnimationFrame = (callback) => {
        count += 1;
        return original.call(window, callback);
      };
      await new Promise((resolve) => setTimeout(resolve, 400));
      window.requestAnimationFrame = original;
      return count;
    });
    assert(frames === 0, `the wallpaper is still drawing: ${frames} frames`);
    step('a live wallpaper falls back to one still frame and its render loop stops');

    // A fresh page proves the stored choice is applied before anything paints,
    // without disturbing the panel connection the rest of the run uses.
    const fresh = await context.newPage();
    await fresh.goto(`chrome-extension://${id}/sidepanel/index.html`);
    await fresh.waitForFunction(() => document.documentElement.dataset.perf === 'performance', null, {
      timeout: 10000,
    });
    await fresh.close();
    step('the graphics mode persists and is applied before the first paint');

    await newTab.close();
    step('the New Tab page is a working chat with the conversation in it, and takes its theme from Settings');

    // Right-click removes a key: the list and the stored pool both lose it.
    const beforeRemove = (await atom.snapshot()).settings.keyCounts.groq;
    await atom.send({ t: 'settings.update', patch: { providerKey: { id: 'groq', keys: ['gsk_throwaway_9999'] } } });
    await panel.waitForFunction(
      (expected) => document.querySelectorAll('#groqKeys .key-item').length === expected,
      beforeRemove + 1,
      { timeout: 10000 },
    );
    await panel.locator('#groqKeys .key-item').first().dispatchEvent('contextmenu');
    await panel.waitForFunction(
      (expected) => document.querySelectorAll('#groqKeys .key-item').length === expected,
      beforeRemove,
      { timeout: 10000 },
    );
    const afterRemove = await atom.snapshot();
    assert(afterRemove.settings.keyCounts.groq === beforeRemove, 'the key was still stored after the right-click');
    step('right-clicking a key removes it from the list and from storage');

    // Playground typing: the real content agent writes into the fixture input
    // without a confirmation, and the page's value is the witness.
    const beforeTypeMode = await atom.count();
    await atom.send({ t: 'settings.update', patch: { agent: { mode: 'playground', stepLimit: 8, trustedSites: [] } } });
    await atom.wait({ kind: 'settings' }, beforeTypeMode);
    stub.replies.push(
      () => toolCall('read_page', '{}', 'call_type_read'),
      () => toolCall('type_text', '{"ref":"e2","text":"ATOM typed this","expect":"ATOM typed this"}', 'call_type_write'),
      () => text('Typed the note.'),
    );
    await fixture.bringToFront();
    const beforeType = await atom.count();
    await atom.send({ t: 'chat.send', text: 'put a note on the fixture page' });
    await atom.wait({ kind: 'busy', busy: false }, beforeType, 40000);

    const typed = await fixture.evaluate(() => document.getElementById('note')?.value || '');
    assert(typed === 'ATOM typed this', `fixture note value: ${typed}`);
    const typeRow = toolRows(await atom.snapshot())
      .filter((row) => row.tool.name === 'type_text')
      .at(-1);
    assert(typeRow?.tool.status === 'done', `type row: ${JSON.stringify(typeRow?.tool)}`);
    step('a Playground turn typed into the real page without a confirmation');

    await atom.send({ t: 'settings.update', patch: { agent: { mode: 'off', stepLimit: 16, trustedSites: [] } } });

    // The side panel is browser UI, not a DOM node. Watch Chromium's own open
    // and close events while a real click opens it, then switch tabs and
    // navigate the active tab. A tab-scoped panel closes here; a window-scoped
    // one does not.
    await worker.evaluate(() => {
      const state = { opened: 0, closed: 0 };
      globalThis.__atomPanelState = state;
      chrome.sidePanel.onOpened.addListener(() => { state.opened += 1; });
      chrome.sidePanel.onClosed.addListener(() => { state.closed += 1; });
    });
    const panelState = () => worker.evaluate(() => globalThis.__atomPanelState);
    const opener = await context.newPage();
    await opener.goto(`chrome-extension://${id}/accept-sidepanel.html`);
    await opener.bringToFront();
    await opener.click('#open');
    await until(async () => (await panelState()).opened >= 1, 'the side panel did not open');
    step('the real side panel opens from a user gesture in Chromium');

    const other = await context.newPage();
    await other.goto(`${stub.origin}/next`);
    await other.bringToFront();
    await new Promise((resolve) => setTimeout(resolve, 300));
    let panelAfter = await panelState();
    assert(panelAfter.closed === 0, `the side panel closed on a tab switch: ${JSON.stringify(panelAfter)}`);
    step('the side panel stays open across a tab switch');

    await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.update(tab.id, { url });
    }, `${stub.origin}/next?after=1`);
    await other.waitForURL(/after=1/, { timeout: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    panelAfter = await panelState();
    assert(panelAfter.closed === 0, `the side panel closed on navigation: ${JSON.stringify(panelAfter)}`);
    step('the side panel stays open across navigation');

    console.log(`\nPASS — ${passed} checks, real Chromium, real extension, real page.`);
    console.log('\nNot covered by this run:');
    console.log('  - the native host-permission prompt (browser UI; the copy pre-grants the fixture origin)');
    console.log('  - the toolbar click itself (the side-panel check opens via chrome.sidePanel.open after a real click on a test extension page)');
    console.log('  - the debugging banner (headless has no UI) and Brave detaching on its own when DevTools opens');
    console.log('  - Groq itself (the provider is a local stub; the real adapter does the SSE parsing)');
  } finally {
    await context.close().catch(() => {});
    await rm(prepared.dir, { recursive: true, force: true }).catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    await new Promise((resolve) => stub.server.close(resolve));
  }
}

run().catch((error) => {
  console.error(`\nFAIL — ${error?.message || error}`);
  if (passed) console.error(`Passed ${passed} check(s) before the failure.`);
  process.exitCode = 1;
});
