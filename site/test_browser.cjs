// Engineering regression tests use an isolated browser, never the user's tabs.
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs/promises');
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SHNOTES_TEST_URL || 'http://127.0.0.1:4319/SHNotes/';
let browser, server;
const engines = {chromium, webkit};
before(async () => {
  if (!process.env.SHNOTES_TEST_URL) {
    server = spawn(process.env.PYTHON || 'python', [path.join(__dirname, 'serve.py'), '--port', '4319', '--prefix', '/SHNotes/'], {stdio: 'ignore'});
    let running = false;
    for (let i = 0; i < 80; i++) {
      try {const response = await fetch(base); if (response.ok) {running = true; break}} catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(running, 'preview server did not start');
  }
  browser = await engines[process.env.BROWSER || 'chromium'].launch({headless: true, ...(process.env.BROWSER_CHANNEL ? {channel: process.env.BROWSER_CHANNEL} : {})});
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped;
  }
});
const loaded = page => page.waitForFunction(() => document.querySelector('#reader-status').hidden);
async function visualProof(page, name) {
  if (!process.env.SHNOTES_VISUAL_DIR) return;
  await fs.mkdir(process.env.SHNOTES_VISUAL_DIR, {recursive: true});
  await page.screenshot({path: path.join(process.env.SHNOTES_VISUAL_DIR, name + '.png')});
}
const settle = page => page.waitForTimeout(650);
async function memory(page) {
  // Storage is deliberately deferred until scrolling/rendering settles.
  await page.waitForFunction(() => {
    const all = JSON.parse(localStorage.getItem('shnotes.reading.v1') || '{}'), point = all[all.last];
    const query = new URLSearchParams(location.hash.split('?')[1]);
    return point && Math.abs(point.y - Number(query.get('y'))) < .05 &&
      (query.get('z') === 'width' ? point.scale === 'page-width' : Math.abs(point.scale - Number(query.get('z'))) < .001);
  });
  return page.evaluate(() => {const m = JSON.parse(localStorage.getItem('shnotes.reading.v1')); return m[m.last]});
}
async function open(context, url = base) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(url); await page.locator('.lecture-card').first().click(); await loaded(page); return page;
}
async function offlineOrigin() {
  const root = path.resolve(__dirname, '../_site');
  const mime = {'.html':'text/html', '.mjs':'text/javascript', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.pdf':'application/pdf', '.png':'image/png', '.svg':'image/svg+xml', '.wasm':'application/wasm'};
  const origin = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (!pathname.startsWith('/SHNotes/')) throw Error();
      const target = path.resolve(root, pathname.slice('/SHNotes/'.length) || 'index.html');
      if (!target.startsWith(root + path.sep)) throw Error();
      const data = await fs.readFile(target);
      response.writeHead(200, {'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Content-Length': data.length}); response.end(data);
    } catch {response.writeHead(404); response.end()}
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${origin.address().port}/SHNotes/`;
  return {url, stop: async () => {if (origin.listening) {origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve))}}};
}
async function pageNumber(page, value) {await page.locator('#page-number').fill(String(value)); await page.locator('#page-number').press('Tab'); await settle(page)}

test('library and reader fit narrow phones, tablets and landscape; focus exit stays accessible', async () => {
  for (const width of [320, 360, 390, 768, 1024, 1366]) {
    const context = await browser.newContext({viewport: {width, height: 844}, hasTouch: width <= 1024});
    try {
      const page = await context.newPage(); await page.goto(base); await page.locator('.lecture-card').first().waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `catalog overflows at ${width}`);
      const navigation = await page.locator('.library-sidebar').boundingBox();
      const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
      if (width <= 900) assert.ok(Math.abs(navigation.width - viewportWidth) < 2, `navigation is capped by PDF styles at ${width}`);
      assert.equal(await page.locator('#manage-offline').evaluate(e => e.closest('.library-sidebar') !== null), true);
      assert.equal(await page.locator('#manage-offline').evaluate(e => e.closest('footer') !== null), false);
      const alignment = await page.evaluate(() => {
        const select=document.querySelector('#search-scope').getBoundingClientRect(),input=document.querySelector('#catalog-search').getBoundingClientRect();
        return Math.abs(select.top+select.height/2-input.top-input.height/2);
      });
      assert.ok(alignment < 1, `search controls are not aligned at ${width}`);
      const topbar = await page.locator('.topbar').boundingBox();
      await page.locator('#catalog-search').fill('несуществующая лекция'); await page.locator('#empty').waitFor();
      const emptyTopbar = await page.locator('.topbar').boundingBox();
      assert.ok(Math.abs(topbar.y - emptyTopbar.y) < 1, `empty search stretches or shifts the header at ${width}`);
      await page.locator('#catalog-search').fill('');
      await page.locator('.lecture-card').first().click(); await loaded(page);
      const pager = await page.locator('.reader-pagination').evaluate(e => {
        const input=e.querySelector('input'), total=e.querySelector('#page-count'), arrows=[...e.querySelectorAll('button')];
        const elements=[input,...arrows], centers=elements.map(element=>{const r=element.getBoundingClientRect();return r.top+r.height/2});
        const horizontal=[input,e.querySelector('.page-separator'),total].map(element=>{const r=element.getBoundingClientRect();return r.left+r.width/2});
        return {inputFont:getComputedStyle(input).fontSize,totalFont:getComputedStyle(total).fontSize,centerSpread:Math.max(...centers)-Math.min(...centers),heights:elements.map(element=>element.getBoundingClientRect().height),spacingDifference:Math.abs(horizontal[1]-horizontal[0]-(horizontal[2]-horizontal[1]))};
      });
      assert.equal(pager.inputFont, pager.totalFont, `page numbers use different sizes at ${width}`);
      assert.ok(pager.centerSpread < 1 && pager.heights.every(height=>height>=44), `page controls are misaligned or hard to tap at ${width}`);
      assert.ok(pager.spacingDifference < 1, `page counter spacing is asymmetric at ${width}`);
      assert.ok(await page.locator('.reader-header svg').evaluateAll(elements=>elements.filter(e=>e.getClientRects().length).every(e=>{const r=e.getBoundingClientRect();return r.width===20&&r.height===20})), `toolbar icons use inconsistent sizes at ${width}`);
      await visualProof(page, `reader-${width}`);
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('.reader-header button,.page-control')].filter(e => e.getClientRects().length).every(e => {const r=e.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth+1})), `reader overflows at ${width}`);
      for (const id of ['previous', 'next', 'fit', 'focus-mode', 'reader-more']) {
        const box = await page.locator('#' + id).boundingBox(); assert.ok(box.width >= 44 && box.height >= 44, `${id} target at ${width}`);
      }
      await page.locator('#focus-mode').click(); await page.setViewportSize({width: 320, height: 568});
      await page.locator('#focus-mode').click(); assert.ok(!await page.locator('#reader').evaluate(e => e.classList.contains('focus')));
      await page.setViewportSize({width: 844, height: 390});
      const viewerBox = await page.locator('#viewerContainer').boundingBox(); assert.ok(viewerBox.y <= 60, 'landscape header is too tall');
      await page.locator('#reader-more').click(); await page.locator('#reader-menu [data-close]').click();
    } finally {await context.close()}
  }
});

test('exact position and zoom survive reload, library return and orientation change; closing releases canvases', async () => {
  const context = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true, deviceScaleFactor: 3});
  try {
    const page = await open(context); await pageNumber(page, 5);
    await page.locator('#viewerContainer').evaluate(e => e.scrollTop += 100); await settle(page);
    const fitted = await memory(page);
    await page.setViewportSize({width: 844, height: 390}); await settle(page);
    assert.ok(Math.abs((await memory(page)).y - fitted.y) < 2, 'fit-to-width rotation moved the text');
    await page.setViewportSize({width: 390, height: 844}); await settle(page);
    await page.locator('#reader-more').click(); await page.locator('#menu-zoom-in').click(); await page.locator('#menu-zoom-in').click(); await page.locator('#reader-menu [data-close]').click();
    await page.locator('#viewerContainer').evaluate(e => {e.scrollTop += 125; e.scrollLeft += 30}); await settle(page);
    const original = await memory(page); await page.reload(); await loaded(page); await settle(page);
    let restored = await memory(page);
    assert.equal(restored.page, original.page); assert.ok(Math.abs(restored.y - original.y) < 2, JSON.stringify({original, restored})); assert.ok(Math.abs(restored.scale - original.scale) < .005);
    await page.setViewportSize({width: 844, height: 390}); await settle(page); restored = await memory(page);
    assert.equal(restored.page, original.page); assert.ok(Math.abs(restored.y - original.y) < 2, 'rotation moved the text');
    await page.locator('#back').click(); await page.locator('#cards').waitFor({state: 'visible'});
    assert.equal(await page.locator('#viewer canvas').count(), 0, 'closed PDF retained canvases');
    await page.locator('#resume').click(); await loaded(page); await settle(page); restored = await memory(page);
    assert.equal(restored.page, original.page); assert.ok(Math.abs(restored.y - original.y) < 2);
    const pixels = await page.locator('#viewer canvas').evaluateAll(elements => elements.map(e => e.width * e.height));
    assert.ok(pixels.every(area => area <= 5242880), 'mobile canvas exceeded memory budget');
    await page.locator('#reader-more').click();
    for (let i = 0; i < 18; i++) await page.locator('#menu-zoom-in').click();
    await page.locator('#reader-menu [data-close]').click(); await settle(page);
    assert.ok((await page.locator('#viewer canvas').evaluateAll(elements => elements.map(e => e.width * e.height))).every(area => area <= 5242880), 'large zoom exceeded the canvas budget');
    assert.ok(page.workers().length > 0, 'PDF worker was not created');
    await page.locator('#back').click();
    for (let i = 0; i < 20 && page.workers().length; i++) await page.waitForTimeout(100);
    assert.equal(page.workers().length, 0, 'closed PDF retained its worker');
  } finally {await context.close()}
});

test('named bookmarks can be opened, renamed and deleted; sharing preserves the PDF location', async () => {
  const context = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true});
  await context.addInitScript(() => Object.defineProperty(navigator, 'share', {value: undefined, configurable: true}));
  try {
    const page = await open(context); await pageNumber(page, 4);
    await page.locator('#reader-more').click(); await page.locator('#menu-bookmarks').click();
    await page.locator('#bookmark-name').fill('Доказательство <важное>'); await page.locator('#bookmark-form button').click();
    assert.equal(await page.locator('[data-bookmark]').innerText(), 'Доказательство <важное>\nСтр. 4');
    await visualProof(page, 'bookmarks-populated');
    await page.locator('[data-rename]').click(); await page.locator('#bookmark-name').fill('Теорема'); await page.locator('#bookmark-form button').click();
    await page.locator('#bookmarks-dialog [data-close]').click(); await pageNumber(page, 8);
    await page.locator('#reader-more').click(); await page.locator('#menu-bookmarks').click(); await page.locator('[data-bookmark]').click();
    assert.equal(await page.locator('#page-number').inputValue(), '4');
    await page.locator('#reader-more').click(); await page.locator('#share-page').click();
    // Headless browsers may offer the native share API; avoid platform dialogs.
    if (await page.locator('#share-dialog').isVisible()) {
      const link = await page.locator('#share-link').inputValue(); assert.match(link, /\/4\?x=.*&y=.*&z=/);
      await visualProof(page, 'share-link');
      const other = await context.newPage(); await other.goto(link); await loaded(other);
      assert.equal(await other.locator('#page-number').inputValue(), '4'); await other.close();
      await page.locator('#share-dialog [data-close]').click();
    }
    await page.locator('#reader-more').click(); await page.locator('#menu-bookmarks').click(); await page.locator('[data-delete]').click();
    assert.equal(await page.locator('[data-bookmark]').count(), 0);
  } finally {await context.close()}
});

test('full text search finds PDF pages, respects subject filters and opens highlighted text', async () => {
  const context = await browser.newContext({viewport: {width: 768, height: 1024}, hasTouch: true});
  try {
    const page = await context.newPage(); await page.goto(base); await page.locator('.lecture-card').first().waitFor();
    await page.locator('#search-scope').selectOption('text'); await page.locator('#catalog-search').fill('теорема');
    await page.locator('.text-result').first().waitFor(); assert.ok(await page.locator('.text-result').count() > 0);
    await page.locator('.filters [data-course="logic"]').click(); await page.locator('.text-result').first().waitFor();
    assert.ok((await page.locator('.text-result small').allTextContents()).every(text => text.startsWith('Матлог')));
    const selectedPage = await page.locator('.text-result').first().getAttribute('data-page');
    await page.locator('.text-result').first().click(); await loaded(page);
    assert.equal(await page.locator('#page-number').inputValue(), selectedPage);
    assert.equal(await page.locator('#find-input').inputValue(), 'теорема');
    await page.locator('.textLayer .highlight').first().waitFor();
  } finally {await context.close()}
});

test('saved lecture reopens with network disabled and supports byte ranges; saved files can be removed', async () => {
  const origin = await offlineOrigin();
  const context = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true});
  try {
    const page = await open(context, origin.url); await pageNumber(page, 3);
    await page.locator('#reader-more').click(); await page.locator('#save-offline').click();
    await page.waitForFunction(() => document.querySelector('#save-offline span').textContent.startsWith('Сохранено'), null, {timeout: 45000});
    await page.locator('#reader-menu [data-close]').click();
    await page.locator('#back').click(); await page.locator('#manage-offline').click();
    await page.locator('[data-remove]').waitFor(); await visualProof(page, 'offline-populated');
    await page.locator('#offline-dialog [data-close]').click(); await page.locator('#resume').click(); await loaded(page);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    // Playwright's WebKit offline flag rejects SW responses before dispatch:
    // https://github.com/microsoft/playwright/issues/42775
    // Stop this isolated origin instead, so both engines exercise real fallback.
    await origin.stop(); await page.reload(); await loaded(page);
    assert.equal(await page.locator('#page-number').inputValue(), '3');
    const range = await page.evaluate(async () => {
      const url = document.querySelector('#download').href;
      const response = await fetch(url, {headers: {Range: 'bytes=0-99'}});
      return {status: response.status, length: (await response.arrayBuffer()).byteLength, contentRange: response.headers.get('Content-Range')};
    });
    assert.equal(range.status, 206); assert.equal(range.length, 100); assert.match(range.contentRange, /^bytes 0-99\//);
    await page.locator('#back').click(); await page.locator('#library').waitFor({state:'visible'});
    assert.equal(new URL(page.url()).hash, '', 'PDF updates must not reopen the reader after returning to the library');
    await page.locator('#manage-offline').click(); await page.locator('[data-remove]').click();
    await page.waitForFunction(() => !document.querySelector('[data-remove]'));
    assert.match(await page.locator('#offline-list').innerText(), /Пока нет/);
  } finally {await context.close(); await origin.stop()}
});

test('failed PDF load offers retry and a direct link; rapid navigation does not attach a stale document', async () => {
  const context = await browser.newContext({serviceWorkers: 'block', viewport: {width: 390, height: 844}, hasTouch: true});
  try {
    const page = await context.newPage(); await page.route('**/*.pdf?*', route => route.abort());
    await page.goto(base); await page.locator('.lecture-card').first().click(); await page.locator('#retry-pdf').waitFor();
    await visualProof(page, 'reader-error');
    assert.match(await page.locator('#fallback-pdf').getAttribute('href'), /#page=1$/);
    await page.unroute('**/*.pdf?*'); await page.locator('#retry-pdf').click(); await loaded(page);
    await page.locator('#back').click(); await page.locator('.lecture-card').nth(1).click(); await page.locator('#back').click();
    await page.locator('.lecture-card').nth(2).click(); await loaded(page);
    assert.match(await page.locator('#reader-title').innerText(), /Типы/);
  } finally {await context.close()}
});

test('native pinch and Ctrl+wheel change PDF scale while normal scrolling crosses pages', {skip: (process.env.BROWSER || 'chromium') !== 'chromium' ? 'Chromium CDP touch dispatch; Safari gesture handlers are covered in unit tests' : false}, async () => {
  const context = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
  try {
    const page = await open(context), cdp = await context.newCDPSession(page);
    const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints});
    const width = () => page.locator('.page').first().evaluate(e => e.getBoundingClientRect().width);
    const initial = await width();
    await send('touchStart', [{x: 120, y: 330, id: 0}, {x: 220, y: 330, id: 1}]);
    for (let i = 1; i <= 5; i++) {await send('touchMove', [{x: 120-i*10, y: 330, id: 0}, {x: 220+i*10, y: 330, id: 1}]); await page.waitForTimeout(20)}
    await send('touchEnd', []); await settle(page); assert.ok(await width() > initial * 1.7);
    assert.equal(await page.evaluate(() => visualViewport.scale), 1);
    const enlarged = await width();
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: 190, y: 330, deltaX: 0, deltaY: 120, modifiers: 2}); await settle(page);
    assert.ok(await width() < enlarged); assert.equal(await page.evaluate(() => visualViewport.scale), 1);
    await page.locator('#fit').click();
    for (let n = 0; n < 5; n++) {
      await send('touchStart', [{x: 180, y: 700, id: 0}]);
      for (let i = 1; i <= 6; i++) {await send('touchMove', [{x: 180, y: 700-i*70, id: 0}]); await page.waitForTimeout(20)}
      await send('touchEnd', []); await page.waitForTimeout(150);
    }
    assert.ok(+await page.locator('#page-number').inputValue() >= 4, 'swipes stopped at a page boundary');
  } finally {await context.close()}
});
