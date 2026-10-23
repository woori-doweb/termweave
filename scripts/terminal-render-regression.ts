import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OwnedCleanup } from './cleanup.ts';
import { chromiumExecutable } from './browser.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, normalizePath, type Plugin } from 'vite';
import { chromium, type CDPSession, type Page } from 'playwright-core';

const root = resolve(import.meta.dir, '..');
const evidence = resolve(root, 'evidence/p2b', process.env.RENDER_LABEL ?? 'candidate');
// Reproduce the installed stack constraints without modifying any source CSS.
const stackBaseline = process.env.RENDER_STACK_BASELINE === '1';
const stackFix = '  flex: 1 1 0;\n  min-width: 0;\n  min-height: 0;\n  width: 100%;\n';
// Test-only modes: --input-policy runs the mirror input/IME guard lane instead of the render lane;
// --negative-control runs it against a PaneTerminal with those connections cut and expects them red.
const args = process.argv.slice(2);
const unknownArgs = args.filter(arg => arg !== '--input-policy' && arg !== '--negative-control');
if (unknownArgs.length) throw new Error(`Unknown arguments: ${unknownArgs.join(' ')}`);
if (args.includes('--negative-control') && !args.includes('--input-policy')) throw new Error('--negative-control applies to --input-policy only');

async function renderRegression(): Promise<void> {
mkdirSync(evidence, { recursive: true });
const cleanup = new OwnedCleanup();
try {
const vite = await createServer({ root, configFile: false, esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'installed-stack-baseline', enforce: 'pre',
    transform(source, id) {
      if (!stackBaseline || !id.endsWith('/src/components/PaneTerminal.css')) return null;
      assert.ok(source.includes(stackFix), 'Expected stack fix must exist for the controlled baseline');
      return source.replace(stackFix, '');
    },
  }, { name: 'synthetic-terminal-render', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== '/render-test') return next();
      void server.transformIndexHtml('/render-test', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/scripts/terminal-render-fixture.tsx"></script></body></html>').then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
    });
  } }] });
cleanup.add('vite', () => vite.close());
await vite.listen();
const address = vite.httpServer!.address() as { port: number };
const executablePath = chromiumExecutable();
if (!executablePath) throw new Error('Set CHROME_PATH to an installed Chromium executable');
const browser = await chromium.launch({ executablePath, headless: true });
cleanup.add('browser', () => browser.close());
const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: Number(process.env.RENDER_DPR ?? 1) });
const errors: string[] = [], measurements: unknown[] = [], failures: string[] = [];
page.on('pageerror', error => { errors.push(error.message); console.error('FIXTURE_PAGE_ERROR', error.message); });
await page.addInitScript(() => {
  localStorage.setItem('termweave:direct-typing', '1');
  const frames: any[] = [], sockets: any[] = [];
  class MockSocket extends EventTarget {
    static OPEN = 1; static CONNECTING = 0; readyState = 0;
    constructor(public url: string) { super(); sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); this.emit({ type: 'snapshot', features: ['input-ready'], panes: [], workspaces: [] }); }); }
    emit(message: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
    send(text: string) {
      const message = JSON.parse(text); frames.push({ ...message, at: performance.now() });
      if (message.type === 'role') this.emit({ type: 'role-ack', mode: message.mode });
      if (message.type === 'attach' || message.type === 'resize') {
        this.emit({ type: 'input-ready', pane_id: message.pane_id, ready: true });
        const cols = message.cols, rows = message.rows;
        let data = '\x1b[2J\x1b[HASCII 한국어 中文 日本語 😀 \x1b[31mANSI\x1b[0m';
        for (let row = 2; row <= rows; row++) data += `\x1b[${row};1H${row === rows ? 'LAST-ROW' : 'synthetic multiline'}\x1b[${row};${cols}H#`;
        this.emit({ type: 'pty-data', pane_id: message.pane_id, data });
      }
    }
    close() { this.readyState = 3; }
  }
  Object.assign(window, { WebSocket: MockSocket, renderFrames: frames, renderSockets: sockets });
});
await page.route('**/api/**', route => route.fulfill({ json: { text: '', messages: [], prompt: null } }));
const measure = async (label: string, settled = true) => {
  if (settled) await page.waitForTimeout(500);
  const result = await page.evaluate(() => {
    const rect = (node: Element) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }; };
    return Array.from(document.querySelectorAll('.dock-group')).map(group => {
      const body = group.querySelector('.dock-drop-body')!, stack = group.querySelector('.terminal-stack')!, mount = group.querySelector('.pane-terminal')!, screen = group.querySelector('.xterm-screen')!;
      const term = (window as any).renderTerms.find((term: any) => term.element?.isConnected && group.contains(term.element));
      const pane = group.getAttribute('data-fixture-pane');
      const geometry = (window as any).renderFrames.filter((frame: any) => ['resize', 'attach'].includes(frame.type) && frame.pane_id === pane).at(-1);
      return { pane, body: rect(body), stack: rect(stack), mount: rect(mount), screen: rect(screen), cols: term?.cols, rows: term?.rows, geometry,
        lastLine: term?.buffer.active.getLine(term.buffer.active.baseY + term.rows - 1)?.translateToString(true), adopted: mount.hasAttribute('data-adopted-grid') };
    });
  });
  measurements.push({ label, result });
  if (settled) for (const value of result) {
    if (!value.adopted && (value.stack.right > value.body.right + 1 || value.stack.bottom > value.body.bottom + 1 || value.mount.right > value.body.right + 1 || value.mount.bottom > value.body.bottom + 1 || value.screen.right > value.mount.right + 1 || value.screen.bottom > value.mount.bottom + 1)) failures.push(`${label}: clipped ${value.pane}`);
    if (!value.adopted && (value.cols !== value.geometry?.cols || value.rows !== value.geometry?.rows)) failures.push(`${label}: grid frame mismatch`);
    if (!value.lastLine?.includes('#')) failures.push(`${label}: last column sentinel missing`);
    if (!value.lastLine?.startsWith('LAST-ROW')) failures.push(`${label}: dynamic last row missing`);
  }
  await page.screenshot({ path: resolve(evidence, `${label}.png`) });
};
  await page.goto(`http://127.0.0.1:${address.port}/render-test`);
  await page.locator('.xterm-screen').waitFor(); await page.evaluate(() => document.fonts.ready);
  await measure('single-initial');
  await page.setViewportSize({ width: 650, height: 800 }); await measure('single-shrink');
  await page.setViewportSize({ width: 1440, height: 950 }); await measure('single-expand');
  await page.getByRole('button', { name: 'Columns', exact: true }).click(); await measure('columns-initial');
  for (const ratio of [0.8, 0.2, 0.5]) {
    const divider = page.locator('.dock-divider'); const bounds = await page.locator('.dock-split').boundingBox(); const box = await divider.boundingBox(); assert.ok(bounds && box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * ratio, box.y + box.height / 2); await page.mouse.up();
    await measure(`slider-${ratio}-immediate`, false); await page.waitForTimeout(150); await measure(`slider-${ratio}-150ms`, false); await measure(`slider-${ratio}-settled`);
  }
  await page.getByRole('button', { name: 'Single', exact: true }).click(); await measure('split-to-single');
  await page.getByRole('button', { name: 'Tab', exact: true }).click(); await measure('tab-change');
  await page.getByRole('button', { name: 'Font', exact: true }).click(); await measure('font-change');
  await page.getByRole('button', { name: 'Rows', exact: true }).click(); await measure('rows-initial');
  for (const ratio of [0.8, 0.2, 0.5]) {
    const divider = page.locator('.dock-divider'), bounds = await page.locator('.dock-split').boundingBox(), box = await divider.boundingBox(); assert.ok(bounds && box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, bounds.y + bounds.height * ratio); await page.mouse.up(); await measure(`rows-${ratio}`);
  }
  await page.getByRole('button', { name: 'Zoom', exact: true }).click(); await measure('zoom');
  await page.getByRole('button', { name: 'Zoom', exact: true }).click(); await measure('zoom-return');
  await page.getByRole('button', { name: 'Single', exact: true }).click(); await page.setViewportSize({ width: 390, height: 844 }); await measure('mobile-single');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('synthetic-input'); await page.keyboard.press('Enter'); await page.keyboard.type('second-line');
  const sentInput = await page.evaluate(() => (window as any).renderFrames.filter((frame: any) => frame.type === 'input').map((frame: any) => frame.text).join(''));
  assert.ok(sentInput.includes('synthetic-input\rsecond-line'));
  const localCols = await page.evaluate(() => (window as any).renderTerms.find((term: any) => term.element?.isConnected)?.cols);
  const sharedBefore = await page.evaluate(() => (window as any).renderFrames.filter((frame: any) => frame.type === 'resize').length);
  await page.evaluate(() => { for (const socket of (window as any).renderSockets) { socket.emit({ type: 'pane-geometry', pane_id: 'synthetic-b', cols: 160, rows: 45 }); socket.emit({ type: 'pty-data', pane_id: 'synthetic-b', data: '\x1b[2J\x1b[45;1HLAST-ROW\x1b[45;160H#' }); } });
  await page.waitForTimeout(200);
  const interactShared = await page.evaluate(() => ({ cols: (window as any).renderTerms.find((term: any) => term.element?.isConnected)?.cols,
    frames: (window as any).renderFrames.filter((frame: any) => frame.type === 'resize').length }));
  assert.equal(interactShared.cols, localCols); assert.equal(interactShared.frames, sharedBefore);
  measurements.push({ label: 'interact-shared-geometry-policy', interactShared });
  await page.getByRole('button', { name: 'Role', exact: true }).click();
  const before = await page.evaluate(() => (window as any).renderFrames.filter((frame: any) => frame.type === 'resize').length);
  await page.evaluate(() => { for (const socket of (window as any).renderSockets) { socket.emit({ type: 'pane-geometry', pane_id: 'synthetic-b', cols: 160, rows: 45 }); socket.emit({ type: 'pty-data', pane_id: 'synthetic-b', data: '\x1b[2J\x1b[45;1HLAST-ROW\x1b[45;160H#' }); } });
  await page.waitForTimeout(200);
  const observe = await page.evaluate(() => ({ frames: (window as any).renderFrames.filter((frame: any) => frame.type === 'resize').length,
    cols: (window as any).renderTerms.find((term: any) => term.element?.isConnected)?.cols,
    overflow: getComputedStyle(document.querySelector('.pane-terminal')!).overflow }));
  assert.equal(observe.frames, before); assert.equal(observe.cols, 160); assert.equal(observe.overflow, 'auto');
  const scroll = await page.locator('.pane-terminal').evaluate(node => { node.scrollLeft = node.scrollWidth; return { left: node.scrollLeft, width: node.clientWidth, total: node.scrollWidth }; });
  if (!(scroll.left > 0 && scroll.left + scroll.width >= scroll.total - 1)) failures.push('observe: adopted last column is not scroll-accessible');
  const observeCell = await page.evaluate(() => { const term = (window as any).renderTerms.find((term: any) => term.element?.isConnected); const node = document.querySelector('.pane-terminal')!; node.scrollTop = node.scrollHeight; return { cell: term.buffer.active.getLine(term.buffer.active.baseY + 44)?.getCell(159)?.getChars(), row: term.buffer.active.getLine(term.buffer.active.baseY + 44)?.translateToString(true), bottom: node.scrollTop + node.clientHeight >= node.scrollHeight - 1 }; });
  if (observeCell.cell !== '#' || !observeCell.row.startsWith('LAST-ROW') || !observeCell.bottom) failures.push('observe: adopted last row/cell not reachable');
  measurements.push({ label: 'observe-adopted-grid', observe, scroll, observeCell });
  await page.getByRole('button', { name: 'Role', exact: true }).click(); await measure('interact-return');
  const fixedBefore = await page.evaluate(() => (window as any).renderFrames.filter((frame: any) => frame.type === 'resize').length);
  await page.evaluate(() => { for (const socket of (window as any).renderSockets) { socket.emit({ type: 'pane-geometry', pane_id: 'synthetic-b', cols: 140, rows: 40, fixed: true }); socket.emit({ type: 'pty-data', pane_id: 'synthetic-b', data: '\x1b[2J\x1b[40;1HLAST-ROW\x1b[40;140H#' }); } });
  await page.waitForTimeout(200); await page.setViewportSize({ width: 420, height: 844 }); await page.waitForTimeout(500);
  const fixed = await page.evaluate(() => ({ cols: (window as any).renderTerms.find((term: any) => term.element?.isConnected)?.cols,
    frames: (window as any).renderFrames.filter((frame: any) => frame.type === 'resize').length, overflow: getComputedStyle(document.querySelector('.pane-terminal')!).overflow }));
  assert.equal(fixed.cols, 140); assert.equal(fixed.frames, fixedBefore); assert.equal(fixed.overflow, 'auto');
  const fixedLastCell = await page.evaluate(() => { const term = (window as any).renderTerms.find((term: any) => term.element?.isConnected); const node = document.querySelector('.pane-terminal')!; node.scrollLeft = node.scrollWidth; node.scrollTop = node.scrollHeight; return { cell: term.buffer.active.getLine(term.buffer.active.baseY + 39)?.getCell(139)?.getChars(), row: term.buffer.active.getLine(term.buffer.active.baseY + 39)?.translateToString(true), rightReachable: node.scrollLeft + node.clientWidth >= node.scrollWidth - 1, bottomReachable: node.scrollTop + node.clientHeight >= node.scrollHeight - 1 }; });
  if (fixedLastCell.cell !== '#' || !fixedLastCell.row.startsWith('LAST-ROW') || !fixedLastCell.rightReachable || !fixedLastCell.bottomReachable) failures.push('fixed: adopted last cell not reachable');
  measurements.push({ label: 'fixed-mirror-grid-preserved', fixed, fixedLastCell });
  assert.deepEqual(errors, []);
  writeFileSync(resolve(evidence, 'execution-manifest.json'), JSON.stringify(Object.fromEntries(['scripts/terminal-render-fixture.tsx', 'scripts/terminal-render-regression.ts', 'src/components/PaneTerminal.tsx', 'src/components/PaneTerminal.css', 'src/components/DockLayout.css', 'src/components/SplitTerminals.css', 'src/lib/terminalWidths.ts', 'src/lib/terminalGlyphs.ts'].map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])), null, 2));
  writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', stackBaseline, effectiveCssSha256: createHash('sha256').update(stackBaseline ? readFileSync(resolve(root, 'src/components/PaneTerminal.css'), 'utf8').replace(stackFix, '') : readFileSync(resolve(root, 'src/components/PaneTerminal.css'))).digest('hex'), failures, errors, measurements }, null, 2));
  assert.deepEqual(failures, [], 'terminal bounds must contain the last row and column');
  console.log('PASS synthetic terminal render: single/split/slider/tab/font/zoom/mobile/observe');
} finally {
  const results = await cleanup.run();
  writeFileSync(resolve(evidence, 'cleanup.json'), JSON.stringify(results, null, 2));
  if (results.some(result => result.status === 'FAIL')) throw new Error('Owned render cleanup failed');
}
}

// --input-policy: the real PaneTerminal, mounted over a mock HerdrSocket transport as a mirror
// (pane-geometry fixed) or an attach grid. What reaches the socket as `input` frames is observed.
const INPUT_POLICY_PANE = 'policy-pane';
const INPUT_POLICY_QUERIES = '\x1b[?1004h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[5n\x1b[6n\x1b[?6n\x1b[c\x1b[>c';
/** what xterm 5.5 answers to the queries, a blur+focus and a middle click (attach keeps every one) */
const INPUT_POLICY_REPLIES = [/\x1b\[0n/, /\x1b\[\d+;\d+R/, /\x1b\[\?\d+;\d+R/, /\x1b\[\?1;2c/, /\x1b\[>0;276;0c/, /\x1b\[O/, /\x1b\[I/, /\x1b\[<1;\d+;\d+M/, /\x1b\[<1;\d+;\d+m/];
const INPUT_POLICY_PASTE = '붙여넣기 \x1b[I reply-shaped\nnext line';
/** abc, ArrowUp, Enter, Ctrl+C, Shift+F3 (a cursor report's shape), an IME-composed 한, a bracketed paste */
const INPUT_POLICY_TYPED = `abc\x1b[A\r\x03\x1b[1;2R한\x1b[200~${INPUT_POLICY_PASTE.replace(/\n/g, '\r')}\x1b[201~`;
/** the PaneTerminal connections the negative control cuts (Vite transform only; the source stays) */
const INPUT_POLICY_CUTS = [
  { name: 'mirror-filter', from: 'filterMirrorInput(mirrorInput, data)', to: '{ send: data, state: mirrorInput }' },
  { name: 'composition-guard', from: 'compositionSettled(compositionRef.current, performance.now())', to: 'true' },
] as const;
type InputPolicyCut = typeof INPUT_POLICY_CUTS[number]['name'];
type InputPolicyCheck = (name: string, cut: InputPolicyCut | null, ok: boolean, detail: unknown) => void;
const INPUT_POLICY_FIXTURE = `import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { PaneTerminal } from '../src/components/PaneTerminal.tsx';
import { SettingsProvider } from '../src/lib/settings.ts';
import '../src/styles.css';

const policy = (window as any).policy;
const open = Terminal.prototype.open;
Terminal.prototype.open = function (parent) { policy.terms.push(this); return open.call(this, parent); };
const reset = Terminal.prototype.reset;
Terminal.prototype.reset = function () { policy.resets++; return reset.call(this); };
function Fixture() {
  const [autoSelected, setAutoSelected] = useState(false);
  policy.setAutoSelected = setAutoSelected;
  useEffect(() => { policy.autoSelected.push(autoSelected); }, [autoSelected]);
  return <main style={{ height: '100dvh', width: '100%' }}><PaneTerminal paneId="${INPUT_POLICY_PANE}" view="terminal" terminalFontSize={14}
    terminalWheelSpeed={1} terminalFontFamily="" theme="dark" palette="amber" role="interact" autoSelected={autoSelected} /></main>;
}
createRoot(document.getElementById('root')!).render(<SettingsProvider><Fixture /></SettingsProvider>);
`;

async function inputPolicyRegression(negative: boolean): Promise<void> {
  const out = resolve(root, 'evidence/input-policy', negative ? 'negative-control' : 'candidate');
  mkdirSync(out, { recursive: true });
  const fixtureId = normalizePath(resolve(root, 'scripts/input-policy-fixture.tsx'));
  const paneTerminalId = normalizePath(resolve(root, 'src/components/PaneTerminal.tsx'));
  const applied = new Set<InputPolicyCut>();
  const checks: { name: string; cut: InputPolicyCut | null; ok: boolean; detail: unknown }[] = [], errors: string[] = [];
  const check: InputPolicyCheck = (name, cut, ok, detail) => {
    checks.push({ name, cut, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${cut ? ` [${cut}]` : ''} ${JSON.stringify(detail)}`);
  };
  const plugin: Plugin = { name: 'input-policy-fixture', enforce: 'pre',
    resolveId(id) { return id === '/scripts/input-policy-fixture.tsx' ? fixtureId : null; },
    load(id) { return id === fixtureId ? INPUT_POLICY_FIXTURE : null; },
    transform(source, id) {
      if (!negative || id.split('?')[0] !== paneTerminalId) return null;
      let cut = source;
      for (const { name, from, to } of INPUT_POLICY_CUTS) {
        const found = cut.split(from).length - 1;
        // a missing connection is a broken control, never a red
        if (found !== 1) throw new Error(`negative control: ${name} connection found ${found} times in PaneTerminal.tsx`);
        cut = cut.replace(from, to);
        applied.add(name);
      }
      return cut;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/input-policy-test')) return next();
        void server.transformIndexHtml(request.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/scripts/input-policy-fixture.tsx"></script></body></html>')
          .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
      });
    } };
  const cleanup = new OwnedCleanup();
  let failure: unknown = null;
  try {
    const vite = await createServer({ root, configFile: false, logLevel: 'warn', esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0 }, plugins: [plugin] });
    cleanup.add('vite', () => vite.close());
    await vite.listen();
    const port = (vite.httpServer!.address() as { port: number }).port;
    const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
    cleanup.add('browser', () => browser.close());
    for (const mode of ['mirror', 'attach'] as const) {
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      cleanup.add(`context-${mode}`, () => context.close());
      const page = await context.newPage();
      page.on('pageerror', error => { errors.push(`${mode}: ${error.stack ?? error.message}`); console.error('FIXTURE_PAGE_ERROR', error.stack ?? error.message); });
      await page.addInitScript(inputPolicyInit, { pane: INPUT_POLICY_PANE, mirror: mode === 'mirror' });
      await page.route('**/api/**', route => route.fulfill({ json: { text: '', messages: [], prompt: null } }));
      await page.goto(`http://127.0.0.1:${port}/input-policy-test?mode=${mode}`);
      await until(page, () => { const policy = (window as any).policy; return policy.terms[0]?.buffer.active.getLine(0)?.translateToString().includes('POLICY') && policy.frames.some((frame: any) => frame.type === 'input-ready-sent'); }, `${mode} fixture screen`);
      const adopted = await page.locator('.pane-terminal').evaluate(node => node.hasAttribute('data-adopted-grid'));
      check(`${mode}-fixture-mode`, null, adopted === (mode === 'mirror'), { adopted });
      const textarea = page.locator('.xterm-helper-textarea');
      await textarea.focus();
      const cdp = await context.newCDPSession(page);

      // xterm's own answers: the queries in the screen, a blur+focus, a middle click
      let from = await frameCount(page);
      await emit(page, { type: 'pty-data', pane_id: INPUT_POLICY_PANE, data: INPUT_POLICY_QUERIES });
      await until(page, () => { const modes = (window as any).policy.terms[0].modes; return modes.sendFocusMode && modes.bracketedPasteMode && modes.mouseTrackingMode === 'vt200'; }, `${mode} query modes`);
      await page.evaluate(() => { const node = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!; node.blur(); node.focus(); });
      const screen = await page.locator('.xterm-screen').boundingBox();
      assert.ok(screen, 'xterm screen has no box');
      await page.mouse.click(screen.x + 40, screen.y + 30, { button: 'middle' });
      await Bun.sleep(300);
      const replies = await sentSince(page, from);
      if (mode === 'mirror') check('mirror-replies-dropped', 'mirror-filter', replies === '', { sent: replies });
      else {
        const missing = INPUT_POLICY_REPLIES.filter(reply => !reply.test(replies)).map(String);
        check('attach-replies-kept', null, missing.length === 0, { sent: replies, missing });
      }

      // typed input, the same in both modes
      from = await frameCount(page);
      await page.keyboard.type('abc');
      for (const key of ['ArrowUp', 'Enter', 'Control+c', 'Shift+F3']) await page.keyboard.press(key);
      for (const text of ['ㅎ', '하', '한']) await cdp.send('Input.imeSetComposition', { text, selectionStart: 1, selectionEnd: 1 });
      await cdp.send('Input.insertText', { text: '한' });
      await Bun.sleep(100);
      await textarea.evaluate((node, text) => {
        const data = new DataTransfer();
        data.setData('text/plain', text);
        node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, INPUT_POLICY_PASTE);
      await Bun.sleep(200);
      const typed = await sentSince(page, from);
      check(`${mode}-typed-input-identical`, null, typed === INPUT_POLICY_TYPED, { sent: typed, expected: INPUT_POLICY_TYPED });

      if (mode === 'mirror') await compositionGuard(page, cdp, check);
      await cdp.detach();
    }
    if (negative) assert.deepEqual([...applied].sort(), INPUT_POLICY_CUTS.map(cut => cut.name).sort(), 'negative control: every cut must reach the served PaneTerminal');
  } catch (error) {
    failure = error;
  } finally {
    const results = await cleanup.run();
    if (results.some(result => result.status === 'FAIL')) failure ??= new Error(`Owned input-policy cleanup failed: ${JSON.stringify(results)}`);
  }
  const red = checks.filter(entry => !entry.ok);
  // The control is red for the right reason: every check of a cut connection fails, everything else
  // (fixture mode, attach replies, typed input, the 350 ms release) still passes, and no page errors.
  const expectedRed = checks.filter(entry => entry.cut !== null);
  const status = failure !== null || errors.length ? 'ERROR'
    : negative ? (expectedRed.length > 0 && red.length === expectedRed.length && red.every(entry => entry.cut !== null) ? 'EXPECTED_RED' : 'CONTROL_FAILED')
      : red.length ? 'FAIL' : 'PASS';
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ status, negative, cuts: negative ? INPUT_POLICY_CUTS : [], applied: [...applied],
    checks, errors, failure: failure === null ? null : String(failure instanceof Error ? failure.stack : failure) }, null, 2));
  if (failure !== null) throw failure;
  assert.deepEqual(errors, [], 'input-policy fixture page errors');
  if (negative) {
    assert.equal(status, 'EXPECTED_RED', `negative control did not turn exactly the cut checks red: ${JSON.stringify(red.map(entry => entry.name))}`);
    console.log(`PASS input-policy negative control: red as expected ${red.map(entry => entry.name).join(', ')} (evidence ${out})`);
  } else {
    assert.deepEqual(red.map(entry => entry.name), [], 'input-policy checks failed');
    console.log(`PASS input policy: ${checks.length} checks (evidence ${out})`);
  }
}

/**
 * Inside the IME's span (compositionstart until compositionend + 350 ms) a reset and a real blur/focus
 * must wait; at 350 ms they run. Page time is a paused Playwright clock, so 349 and 350 are exact.
 */
async function compositionGuard(page: Page, cdp: CDPSession, check: InputPolicyCheck): Promise<void> {
  await emit(page, { type: 'error', code: 'output_stalled', message: 'synthetic stall', pane_id: INPUT_POLICY_PANE });
  // the stalled-output banner's Reconnect (its label follows the browser's language)
  const reconnect = page.locator('.terminal-banner-output-error button');
  await reconnect.waitFor();
  await page.locator('.xterm-helper-textarea').focus();
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
  const base = await probe(page);
  const delta = async () => {
    const now = await probe(page);
    return { resets: now.resets - base.resets, attaches: now.attaches - base.attaches, focus: now.focus - base.focus, blur: now.blur - base.blur,
      synthetic: now.synthetic - base.synthetic, compositionEnds: now.compositionEnds - base.compositionEnds };
  };

  await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
  await reconnect.evaluate(node => (node as HTMLButtonElement).click()); // a click that leaves the IME's focus alone
  await requestFocus(page);
  const composing = await delta();
  check('guard-composing-no-reset', 'composition-guard', composing.resets === 0 && composing.attaches === 0, composing);
  check('guard-composing-no-real-blur-focus', 'composition-guard', composing.focus === 0 && composing.blur === 0, composing);
  check('guard-composing-synthetic-focus', 'composition-guard', composing.synthetic >= 1, composing);

  await cdp.send('Input.insertText', { text: '한' });
  const ended = await delta();
  check('guard-compositionend-seen', null, ended.compositionEnds === 1, ended);
  await page.clock.runFor(349);
  await requestFocus(page);
  const at349 = await delta();
  check('guard-349ms-no-reset', 'composition-guard', at349.resets === 0 && at349.attaches === 0, at349);
  check('guard-349ms-no-real-blur-focus', 'composition-guard', at349.focus === 0 && at349.blur === 0, at349);

  await page.clock.runFor(1);
  await requestFocus(page);
  const at350 = await delta();
  check('guard-350ms-reset-released', null, at350.resets === 1 && at350.attaches === 1, at350);
  check('guard-350ms-focus-released', null, at350.focus >= 1 && at350.blur === 0, at350);
}

/** Runs in the page before its scripts: a mock WebSocket transport and focus/blur/composition probes. */
function inputPolicyInit({ pane, mirror }: { pane: string; mirror: boolean }): void {
  localStorage.setItem('termweave:direct-typing', '1');
  const policy: any = { frames: [], sockets: [], terms: [], resets: 0, autoSelected: [], calls: { focus: 0, blur: 0, synthetic: 0 }, compositionEnds: 0 };
  (window as any).policy = policy;
  for (const name of ['focus', 'blur'] as const) {
    const original = HTMLElement.prototype[name];
    HTMLElement.prototype[name] = function (this: HTMLElement, ...rest: any[]) {
      if (this.classList.contains('xterm-helper-textarea')) policy.calls[name]++;
      return (original as any).apply(this, rest);
    };
  }
  document.addEventListener('focus', event => { if (!event.isTrusted && (event.target as Element)?.classList?.contains('xterm-helper-textarea')) policy.calls.synthetic++; }, true);
  document.addEventListener('compositionend', () => { policy.compositionEnds++; }, true);
  class MockSocket extends EventTarget {
    static OPEN = 1; static CONNECTING = 0; readyState = 0;
    constructor(public url: string) {
      super(); policy.sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); this.emit({ type: 'snapshot', features: ['input-ready'], panes: [], workspaces: [] }); });
    }
    emit(message: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
    send(text: string) {
      const message = JSON.parse(text);
      policy.frames.push(message);
      if (message.type === 'role') this.emit({ type: 'role-ack', mode: message.mode });
      if (message.type === 'attach' && message.pane_id === pane) {
        this.emit({ type: 'input-ready', pane_id: pane, ready: true });
        policy.frames.push({ type: 'input-ready-sent' });
        // a mirror's grid is the pane's own in herdr: every client adopts it
        if (mirror) this.emit({ type: 'pane-geometry', pane_id: pane, cols: 100, rows: 30, fixed: true });
        this.emit({ type: 'pty-data', pane_id: pane, data: `\x1b[2J\x1b[HPOLICY ${mirror ? 'mirror' : 'attach'} screen 한국어` });
      }
    }
    close() { this.readyState = 3; }
  }
  Object.assign(window, { WebSocket: MockSocket });
}

async function until(page: Page, predicate: () => unknown, label: string, timeout = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await page.evaluate(predicate))) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}
/** to PaneTerminal's HerdrSocket only: Vite's own HMR socket is a MockSocket too */
function emit(page: Page, message: unknown) {
  return page.evaluate(value => { for (const socket of (window as any).policy.sockets) if (new URL(socket.url).pathname === '/ws') socket.emit(value); }, message);
}
function frameCount(page: Page) { return page.evaluate(() => (window as any).policy.frames.length as number); }
function sentSince(page: Page, from: number) {
  return page.evaluate(start => (window as any).policy.frames.slice(start).filter((frame: any) => frame.type === 'input').map((frame: any) => frame.text).join('') as string, from);
}
function probe(page: Page) {
  return page.evaluate(() => {
    const policy = (window as any).policy;
    return { resets: policy.resets as number, attaches: policy.frames.filter((frame: any) => frame.type === 'attach').length as number,
      focus: policy.calls.focus as number, blur: policy.calls.blur as number, synthetic: policy.calls.synthetic as number, compositionEnds: policy.compositionEnds as number };
  });
}
/** autoSelected true, then false: PaneTerminal's autoSelected effect gives the grid the keyboard */
async function requestFocus(page: Page): Promise<void> {
  for (const value of [true, false]) {
    const seen = await page.evaluate(() => (window as any).policy.autoSelected.length as number);
    await page.evaluate(next => (window as any).policy.setAutoSelected(next), value);
    const start = Date.now();
    while (!(await page.evaluate(([count, next]) => { const list = (window as any).policy.autoSelected; return list.length > count && list.at(-1) === next; }, [seen, value] as const))) {
      if (Date.now() - start > 5_000) throw new Error(`timed out waiting for autoSelected=${value}`);
      await Bun.sleep(10);
    }
  }
}

// last: the lanes read the constants above
if (args.includes('--input-policy')) await inputPolicyRegression(args.includes('--negative-control'));
else await renderRegression();
