import {installPDFTouchGestures, installPDFWheelZoom} from './reader-touch.mjs';
import {capturePosition, restorePosition, validPosition, positionHash, parseRoute} from './reading-state.mjs';
import {normalize, searchPages} from './search.mjs';
import {offlineCommand} from './offline.mjs';

const $ = selector => document.querySelector(selector);
const container = $('#viewerContainer');
const compactReader = matchMedia('(max-width:900px), (max-width:1200px) and (pointer:coarse)');
let catalog = [], course = 'all', active = null, viewer, eventBus, linkService, findController;
let loadingTask, viewerInit, loadId = 0, ready = false, restoring = false;
let memory = {}, bookmarks = {}, saved = [], lastPosition, fittedWidth = 0, refitFrame = 0;
let persistTimer, positionTimer, searchTimer, searchId = 0, searchIndex, toastTimer, saving = false;
const resetTouch = installPDFTouchGestures(container, () => ready ? viewer : null);
const resetWheel = installPDFWheelZoom($('#reader'), () => ready ? viewer : null);
$('#reader').addEventListener('wheel', event => {
  if (active && (event.ctrlKey || event.metaKey)) event.preventDefault();
}, {passive: false});
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const name = course => course === 'logic' ? 'Матлог' : 'Дискретка';
const lectureLabel = item => item.number == null ? 'КОНСПЕКТ' : `ЛЕКЦИЯ ${String(item.number).padStart(2, '0')}`;
const plural = (n, one, few, many) => n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
for (const [key, assign] of [['shnotes.reading.v1', value => memory = value], ['shnotes.bookmarks.v1', value => bookmarks = value]]) {
  try {const value = JSON.parse(localStorage.getItem(key) || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) assign(value)} catch {}
}
const pageOf = id => validPosition(memory[id], catalog.find(x => x.id === id)?.pages || 1).page;

function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => $('#toast').hidden = true, 5000);
}
function persistNow() {
  clearTimeout(persistTimer);
  try {
    localStorage.setItem('shnotes.reading.v1', JSON.stringify(memory));
    localStorage.setItem('shnotes.bookmarks.v1', JSON.stringify(bookmarks));
  } catch {if (active) toast('Браузер не разрешил сохранить место чтения.')}
}
function persist() {clearTimeout(persistTimer); persistTimer = setTimeout(persistNow, 400)}
function rememberPosition({history = true} = {}) {
  if (!active || !ready || restoring) return;
  const point = capturePosition(viewer);
  if (!point) return;
  lastPosition = point;
  memory[active.id] = point; memory.last = active.id; persist();
  if (history) historyReplace(positionHash(active.id, point));
}
function historyReplace(hash) {
  const url = new URL(location.href); url.hash = hash; history.replaceState(null, '', url);
}
function queuePosition() {
  if (!ready || restoring) return;
  clearTimeout(positionTimer);
  positionTimer = setTimeout(() => rememberPosition(), 180);
}
container.addEventListener('scroll', queuePosition, {passive: true});
document.addEventListener('visibilitychange', () => {if (document.hidden) {rememberPosition(); persistNow()}});
window.addEventListener('pagehide', () => {rememberPosition(); persistNow()});

function render() {
  const query = normalize($('#catalog-search').value).trim();
  const textMode = $('#search-scope').value === 'text';
  const list = catalog.filter(item => (course === 'all' || item.course === course) && (textMode || normalize(`${item.title} ${item.description} ${name(item.course)} ${item.number ?? ''}`).includes(query)));
  $('#cards').hidden = textMode && !!query;
  $('#text-results').hidden = !textMode || !query;
  $('#cards').innerHTML = list.map(item => `<button class="lecture-card ${item.course}" data-id="${item.id}" aria-label="Читать: ${escape(item.title)}"><span class="cover-stage"><img src="${item.cover}" alt="Обложка конспекта ${item.number ?? ''}" width="536" height="758" loading="lazy"></span><span class="card-info"><span class="card-course">${name(item.course)}${saved.some(x => x.id === item.id) ? ' · БЕЗ ИНТЕРНЕТА' : ''}</span><span class="card-number">${lectureLabel(item)}</span><span class="card-title">${escape(item.title)}</span><span class="card-description">${escape(item.description)}</span><span class="card-bottom"><span>${item.pages} стр. · ${memory[item.id] ? 'Стр. ' + pageOf(item.id) : 'PDF'}</span><span class="card-arrow" aria-hidden="true">↗</span></span></span><span class="card-progress" style="--progress:${memory[item.id] ? pageOf(item.id) / item.pages * 100 : 0}%"></span></button>`).join('');
  $('#result-count').textContent = `${list.length} ${plural(list.length, 'КОНСПЕКТ', 'КОНСПЕКТА', 'КОНСПЕКТОВ')}`;
  $('#total-pages').textContent = `${list.reduce((sum, item) => sum + item.pages, 0)} стр.`;
  $('#empty').hidden = !!list.length || (textMode && !!query);
  document.querySelectorAll('[data-course]').forEach(button => {
    button.classList.toggle('active', button.dataset.course === course);
    button.setAttribute('aria-pressed', String(button.dataset.course === course));
    const badge = button.querySelector('b');
    if (badge) badge.textContent = String(catalog.filter(item => button.dataset.course === 'all' || item.course === button.dataset.course).length).padStart(2, '0');
  });
  const last = catalog.find(item => item.id === memory.last);
  $('#resume').hidden = !last;
  if (last) {$('#resume-title').textContent = last.title; $('#resume-page').textContent = `Стр. ${pageOf(last.id)} из ${last.pages}`}
  $('#offline-count').textContent = saved.length ? `(${saved.length})` : '';
  clearTimeout(searchTimer); searchId++;
  if (textMode && query) {
    $('#text-results').innerHTML = '<p class="loading">Ищем в конспектах…</p>';
    const request = searchId;
    searchTimer = setTimeout(() => globalSearch(query, list, request), 180);
  }
}
async function globalSearch(query, items, request) {
  try {
    searchIndex ||= fetch('./search-index.json').then(async response => {if (!response.ok) throw Error(); return response.json()}).catch(error => {searchIndex = null; throw error});
    const pages = await searchIndex;
    if (request !== searchId) return;
    const {results, total} = searchPages(pages, query, new Set(items.map(item => item.id)));
    $('#result-count').textContent = `${total} ${plural(total, 'СТРАНИЦА', 'СТРАНИЦЫ', 'СТРАНИЦ')}`;
    $('#total-pages').textContent = total > results.length ? `Первые ${results.length} результатов · уточните запрос` : 'По всем выбранным конспектам';
    $('#text-results').innerHTML = results.length ? results.map(result => {
      const item = catalog.find(item => item.id === result.id);
      return `<button class="text-result" data-id="${result.id}" data-page="${result.page}"><small>${name(item.course)} · ${lectureLabel(item)} · Стр. ${result.page}</small><strong>${escape(item.title)}</strong><span>${escape(result.snippet)}</span></button>`;
    }).join('') : '<p class="empty">Совпадений нет. Попробуйте слово или несколько слов из конспекта.</p>';
  } catch {if (request === searchId) $('#text-results').innerHTML = '<p class="empty">Поиск не загрузился. Проверьте соединение и повторите запрос.</p>'}
}
document.querySelectorAll('[data-course]').forEach(button => button.onclick = () => {
  course = button.dataset.course; $('#breadcrumb').textContent = course === 'all' ? 'БИБЛИОТЕКА' : name(course).toUpperCase(); render();
});
$('#catalog-search').oninput = render; $('#search-scope').onchange = render;
$('#cards').onclick = event => {const button = event.target.closest('[data-id]'); if (button) location.hash = `read/${button.dataset.id}`};
$('#text-results').onclick = event => {
  const button = event.target.closest('[data-id]');
  if (button) location.hash = `read/${button.dataset.id}/${button.dataset.page}?q=${encodeURIComponent($('#catalog-search').value.trim())}`;
};
$('#resume').onclick = () => location.hash = `read/${memory.last}`;
$('#back').onclick = () => {rememberPosition({history: false}); location.hash = ''};

async function initViewer() {
  if (viewerInit) return viewerInit;
  viewerInit = (async () => {
    const pdfjs = await import('./vendor/build/pdf.mjs'); globalThis.pdfjsLib = pdfjs;
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/build/pdf.worker.mjs', import.meta.url).href;
    const ui = await import('./vendor/web/pdf_viewer.mjs');
    eventBus = new ui.EventBus(); linkService = new ui.PDFLinkService({eventBus}); findController = new ui.PDFFindController({eventBus, linkService});
    viewer = new ui.PDFViewer({container, viewer: $('#viewer'), eventBus, linkService, findController,
      annotationEditorMode: -1, removePageBorders: true, maxCanvasPixels: matchMedia('(pointer:coarse)').matches ? 5242880 : 16777216});
    linkService.setViewer(viewer);
    eventBus.on('pagesinit', () => initializePosition(loadId, viewer.pdfDocument));
    eventBus.on('pagerendered', ({source, error}) => {
      if (!active || !ready || !viewer.pdfDocument || viewer.getPageView(source.id - 1) !== source) return;
      if (error) showError('Не удалось отрисовать страницу. Повторите загрузку или откройте PDF отдельно.');
      else if ($('#reader-error-actions').hidden) $('#reader-status').hidden = true;
    });
    eventBus.on('pagechanging', ({pageNumber}) => {if (active && ready) updatePage(pageNumber)});
    eventBus.on('scalechanging', ({scale, presetValue}) => {
      $('#fit').textContent = presetValue === 'page-width' ? 'Ширина' : `${Math.round(scale * 100)}%`; queuePosition();
    });
    eventBus.on('updateviewarea', queuePosition);
    eventBus.on('updatefindmatchescount', ({matchesCount}) => $('#find-results').textContent = `${matchesCount.current} / ${matchesCount.total}`);
    eventBus.on('updatefindcontrolstate', ({state, matchesCount}) => $('#find-results').textContent = state === 1 ? 'Не найдено' : state === 3 ? 'Поиск…' : `${matchesCount?.current || 0} / ${matchesCount?.total || 0}`);
  })().catch(error => {viewerInit = null; throw error});
  return viewerInit;
}
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
async function initializePosition(id, doc) {
  restoring = true;
  try {
    await viewer.pagesPromise;
    if (id !== loadId || !active || doc !== viewer.pdfDocument) return;
    fittedWidth = container.clientWidth;
    restorePosition(viewer, active.initialPosition);
    await nextFrame();
    if (id !== loadId || !active || doc !== viewer.pdfDocument) return;
    restorePosition(viewer, active.initialPosition, {scale: false});
    restoring = false; ready = true; updatePage(viewer.currentPageNumber); rememberPosition();
    if (viewer.getPageView(viewer.currentPageNumber - 1)?.renderingState === 3) $('#reader-status').hidden = true;
    if (active.query) {showFind(); $('#find-input').value = active.query; find()}
  } catch (error) {if (id === loadId) showError('Не удалось восстановить страницу. Повторите загрузку.'); console.error(error)}
}
function updatePage(page) {
  $('#page-number').value = page; $('#previous').disabled = page <= 1; $('#next').disabled = page >= active.pages;
  $('#progress-label').textContent = `${page} / ${active.pages}`; $('#progress-bar').style.width = `${page / active.pages * 100}%`;
  let selected;
  for (const button of $('#outline').querySelectorAll('button')) {button.classList.remove('active'); if (+button.dataset.page <= page) selected = button}
  selected?.classList.add('active');
  $('#direct-pdf').href = $('#fallback-pdf').href = `${active.file}#page=${page}`;
  queuePosition();
}
function detachDocument() {
  ready = false; restoring = false; resetTouch(); resetWheel(); clearTimeout(positionTimer);
  viewer?.setDocument(null); linkService?.setDocument(null); findController?.setDocument(null);
  const old = loadingTask; loadingTask = null;
  return old?.destroy().catch(error => console.warn('PDF cleanup', error));
}
function showError(message) {
  $('#reader-status-text').textContent = message; $('#reader-error-actions').hidden = false; $('#reader-status').hidden = false;
}
async function openReader(item, position, query = '') {
  rememberPosition({history: false});
  const id = ++loadId, destruction = detachDocument();
  const stored = saved.find(record => record.id === item.id);
  if (!navigator.onLine && stored?.lecture) item = {...stored.lecture, file: stored.file};
  active = {...item, initialPosition: validPosition(position || memory[item.id], item.pages), query}; lastPosition = active.initialPosition;
  $('#library').hidden = true; $('#reader').hidden = false; document.body.style.overflow = 'hidden';
  $('#reader').classList.remove('focus'); updateFocusButton(); setOutline(!compactReader.matches);
  $('#reader-title').textContent = item.title; $('#reader-title').title = item.title; $('#reader-course').textContent = `${name(item.course)} / ${lectureLabel(item)}`;
  document.title = `${item.title} — SH Notes`;
  $('#download').href = item.file; $('#page-count').textContent = item.pages; $('#page-number').max = item.pages;
  $('#direct-pdf').href = $('#fallback-pdf').href = `${item.file}#page=${active.initialPosition.page}`;
  $('#outline-count').textContent = item.outline.filter(entry => entry.level === 1).length;
  $('#outline').innerHTML = item.outline.length ? item.outline.map(entry => `<button class="${entry.level > 1 ? 'sub' : ''}" data-page="${entry.page}"><span>${escape(entry.title)}</span><small>${entry.page}</small></button>`).join('') : '<p class="outline-empty">В этом PDF нет оглавления. Используйте номера страниц или поиск.</p>';
  $('#reader-status-text').textContent = 'Открываем конспект…'; $('#reader-status').hidden = false; $('#reader-error-actions').hidden = true;
  $('#findbar').hidden = true; $('#find-input').value = ''; $('#find-results').textContent = '';
  updateOfflineButton();
  try {
    await Promise.all([initViewer(), destruction]); if (id !== loadId) return;
    const task = loadingTask = globalThis.pdfjsLib.getDocument({url: item.file, cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href,
      cMapPacked: true, standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href,
      wasmUrl: new URL('./vendor/wasm/', import.meta.url).href, enableScripting: false});
    const doc = await task.promise; if (id !== loadId) return;
    linkService.setDocument(doc); viewer.setDocument(doc);
  } catch (error) {if (id !== loadId) return; showError('Не удалось открыть конспект. Проверьте соединение и повторите загрузку.'); console.error(error)}
}
function route() {
  const parsed = parseRoute(location.hash, catalog);
  if (parsed) openReader(parsed.item, parsed.position, parsed.query);
  else {
    rememberPosition({history: false}); persistNow(); loadId++; detachDocument(); active = null; lastPosition = null;
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    $('#reader').hidden = true; $('#library').hidden = false; document.body.style.overflow = ''; document.title = 'SH Notes — Библиотека'; render();
  }
}
window.addEventListener('hashchange', route);
$('#retry-pdf').onclick = () => {if (active) openReader(catalog.find(item => item.id === active.id), lastPosition)};
function goToPage(page) {if (ready) {viewer.currentPageNumber = Math.max(1, Math.min(active.pages, Math.floor(Number(page) || 1))); rememberPosition()}}
$('#outline').onclick = event => {const button = event.target.closest('[data-page]'); if (button && ready) {goToPage(button.dataset.page); if (compactReader.matches) setOutline(false)}};
$('#previous').onclick = () => goToPage(viewer?.currentPageNumber - 1);
$('#next').onclick = () => goToPage(viewer?.currentPageNumber + 1);
$('#page-number').onchange = event => goToPage(event.target.value);
function zoom(factor) {
  if (!ready) return;
  const bounds = container.getBoundingClientRect();
  viewer.updateScale({scaleFactor: Math.max(.1, Math.min(4, viewer.currentScale * factor)) / viewer.currentScale, origin: [bounds.left + bounds.width / 2, bounds.top + bounds.height / 2]});
  rememberPosition();
}
$('#zoom-out').onclick = $('#menu-zoom-out').onclick = () => zoom(1 / 1.15);
$('#zoom-in').onclick = $('#menu-zoom-in').onclick = () => zoom(1.15);
$('#fit').onclick = () => {if (ready) {const point = capturePosition(viewer); point.scale = 'page-width'; restorePosition(viewer, point); rememberPosition()}};

function refit() {
  if (refitFrame) return;
  refitFrame = requestAnimationFrame(() => {
    refitFrame = 0;
    if (!ready || restoring || container.clientWidth === fittedWidth) return;
    const point = lastPosition || capturePosition(viewer);
    fittedWidth = container.clientWidth; restoring = true;
    restorePosition(viewer, point); restoring = false; rememberPosition();
  });
}
function preserveLayout(change) {if (ready) {rememberPosition(); lastPosition = capturePosition(viewer)} change(); refit()}
function setOutline(open) {preserveLayout(() => {$('#reader').classList.toggle('no-outline', !open); $('#toggle-outline').setAttribute('aria-expanded', String(open))})}
function updateFocusButton() {
  const focused = $('#reader').classList.contains('focus');
  $('#focus-mode').setAttribute('aria-pressed', String(focused));
  $('#focus-mode').setAttribute('aria-label', focused ? 'Выйти из режима чтения' : 'Режим сосредоточенного чтения');
  $('#focus-mode').title = focused ? 'Выйти из режима чтения' : 'Режим сосредоточенного чтения';
  $('#focus-mode').textContent = focused ? '×' : '⛶';
}
function toggleFocus() {preserveLayout(() => {$('#reader').classList.toggle('focus'); updateFocusButton()})}
$('#toggle-outline').onclick = () => {if ($('#reader').classList.contains('focus')) toggleFocus(); setOutline($('#reader').classList.contains('no-outline'))};
$('#outline-dismiss').onclick = () => {setOutline(false); $('#toggle-outline').focus()};
$('#focus-mode').onclick = toggleFocus;
new ResizeObserver(refit).observe(container);
compactReader.addEventListener('change', event => {if (active && event.matches) setOutline(false)});

function find(type = '', previous = false) {
  if (!ready) return;
  eventBus.dispatch('find', {source: window, type, query: $('#find-input').value, phraseSearch: true,
    caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false});
}
function showFind() {$('#findbar').hidden = false; $('#find-input').focus()}
function closeFind() {$('#findbar').hidden = true; eventBus?.dispatch('findbarclose', {source: window}); (compactReader.matches ? $('#reader-more') : $('#toggle-find')).focus()}
$('#toggle-find').onclick = () => $('#findbar').hidden ? showFind() : closeFind();
$('#find-close').onclick = closeFind;
$('#find-input').oninput = () => find(); $('#find-input').onkeydown = event => {if (event.key === 'Enter') find('again', event.shiftKey)};
$('#find-next').onclick = () => find('again'); $('#find-prev').onclick = () => find('again', true);

function showDialog(id) {document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); $(id).showModal()}
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('click', event => {if (event.target === dialog) {const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close()}});
});
$('#reader-more').onclick = () => {rememberPosition(); updateOfflineButton(); showDialog('#reader-menu')};
$('#menu-find').onclick = () => {$('#reader-menu').close(); showFind()};
$('#menu-bookmarks').onclick = () => {renderBookmarks(); showDialog('#bookmarks-dialog')};
function renderBookmarks() {
  const entries = Array.isArray(bookmarks[active.id]) ? bookmarks[active.id] : [];
  $('#bookmark-list').innerHTML = entries.length ? entries.map(entry => `<div class="saved-row"><button data-bookmark="${escape(entry.id)}"><strong>${escape(entry.title)}</strong><small>Стр. ${entry.position.page}</small></button><button data-rename="${escape(entry.id)}" aria-label="Переименовать: ${escape(entry.title)}">✎</button><button data-delete="${escape(entry.id)}" aria-label="Удалить: ${escape(entry.title)}">×</button></div>`).join('') : '<p class="dialog-note">Закладок пока нет. Сохраните место с понятным названием.</p>';
}
$('#bookmark-form').onsubmit = event => {
  event.preventDefault(); if (!ready) return toast('Дождитесь открытия конспекта.');
  const title = $('#bookmark-name').value.trim(); if (!title) return;
  const entries = Array.isArray(bookmarks[active.id]) ? bookmarks[active.id] : [];
  const editing = $('#bookmark-form').dataset.editing;
  if (editing) {const entry = entries.find(entry => entry.id === editing); if (entry) entry.title = title}
  else entries.push({id: globalThis.crypto.randomUUID(), title, position: capturePosition(viewer)});
  bookmarks[active.id] = entries; persistNow(); $('#bookmark-name').value = ''; delete $('#bookmark-form').dataset.editing;
  $('#bookmark-form button').textContent = 'Добавить'; renderBookmarks();
};
$('#bookmarks-dialog').addEventListener('close', () => {delete $('#bookmark-form').dataset.editing; $('#bookmark-name').value = ''; $('#bookmark-form button').textContent = 'Добавить'});
$('#bookmark-list').onclick = event => {
  const button = event.target.closest('button'); if (!button || !active) return;
  const entries = bookmarks[active.id] || [];
  if (button.dataset.bookmark && ready) {const entry = entries.find(entry => entry.id === button.dataset.bookmark); if (entry) {restorePosition(viewer, entry.position); rememberPosition(); $('#bookmarks-dialog').close()}}
  if (button.dataset.delete) {bookmarks[active.id] = entries.filter(entry => entry.id !== button.dataset.delete); persistNow(); renderBookmarks()}
  if (button.dataset.rename) {
    const entry = entries.find(entry => entry.id === button.dataset.rename);
    if (entry) {$('#bookmark-form').dataset.editing = entry.id; $('#bookmark-name').value = entry.title; $('#bookmark-form button').textContent = 'Сохранить'; $('#bookmark-name').focus()}
  }
};
$('#share-page').onclick = async () => {
  if (!ready) return toast('Дождитесь открытия конспекта.');
  const point = capturePosition(viewer), url = new URL(location.href); url.hash = positionHash(active.id, point);
  $('#reader-menu').close();
  if (navigator.share) {
    try {await navigator.share({title: `${active.title} · стр. ${point.page}`, url: url.href}); return}
    catch (error) {if (error.name === 'AbortError') return}
  }
  $('#share-link').value = url.href; showDialog('#share-dialog'); $('#share-link').select();
};
$('#copy-link').onclick = async () => {
  try {await navigator.clipboard.writeText($('#share-link').value); toast('Ссылка скопирована.'); $('#share-dialog').close()}
  catch {$('#share-link').select(); toast('Выделенная ссылка готова к копированию.')}
};

function updateOfflineButton() {
  const record = active && saved.find(record => record.id === active.id);
  const current = record && new URL(active.file, location.href).href === record.file;
  $('#save-offline span').textContent = saving ? 'Сохраняем…' : current ? 'Сохранено · обновить копию' : record ? 'Обновить сохранённый PDF' : 'Сохранить без интернета';
  $('#save-offline').disabled = saving || !active;
}
async function refreshSaved() {
  saved = await offlineCommand('list'); updateOfflineButton(); if (!active) render();
}
$('#save-offline').onclick = async () => {
  if (!active || saving) return;
  saving = true; updateOfflineButton();
  const item = catalog.find(item => item.id === active.id);
  try {
    await offlineCommand('save', {item}, progress => $('#save-offline span').textContent = `Сохраняем: ${Math.round(progress.done / progress.total * 100)}%`);
    await refreshSaved(); toast('Конспект и читалка сохранены для чтения без интернета.');
  } catch (error) {toast(error.message)}
  finally {saving = false; updateOfflineButton()}
};
function renderOffline() {
  $('#offline-list').innerHTML = saved.length ? saved.map(record => `<div class="saved-row"><button data-saved="${record.id}"><strong>${escape(record.title)}</strong><small>${(record.size / 1024 / 1024).toFixed(2)} МБ · ${new Date(record.savedAt).toLocaleDateString('ru')}</small></button><button data-remove="${record.id}" aria-label="Удалить сохранённый PDF: ${escape(record.title)}">×</button></div>`).join('') : '<p class="dialog-note">Пока нет сохранённых конспектов.</p>';
}
$('#manage-offline').onclick = async () => {
  showDialog('#offline-dialog'); $('#offline-status').textContent = 'Проверяем сохранённые файлы…';
  try {await refreshSaved(); renderOffline(); $('#offline-status').textContent = ''} catch (error) {$('#offline-status').textContent = error.message}
};
$('#offline-list').onclick = async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.saved) {$('#offline-dialog').close(); location.hash = `read/${button.dataset.saved}`}
  if (button.dataset.remove) {
    button.disabled = true;
    try {await offlineCommand('remove', {id: button.dataset.remove}); await refreshSaved(); renderOffline(); $('#offline-status').textContent = 'Сохранённый PDF удалён.'}
    catch (error) {button.disabled = false; $('#offline-status').textContent = error.message}
  }
};
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  const editing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
  if (active && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {event.preventDefault(); showFind()}
  if (event.key === 'Escape' && active) {
    if (!$('#findbar').hidden) closeFind(); else if ($('#reader').classList.contains('focus')) toggleFocus(); else if (compactReader.matches && !$('#reader').classList.contains('no-outline')) setOutline(false);
  }
  if (active && ready && !editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (['ArrowLeft','ArrowRight'].includes(event.key)) {event.preventDefault(); goToPage(viewer.currentPageNumber + (event.key === 'ArrowRight' ? 1 : -1))}
  }
  if (!active && event.key === '/' && !editing) {event.preventDefault(); $('#catalog-search').focus()}
});
try {
  const response = await fetch('./catalog.json'); if (!response.ok) throw Error('Catalog unavailable');
  catalog = await response.json();
  if (!navigator.onLine) {try {await refreshSaved()} catch {}}
  render(); route();
  if (navigator.onLine) refreshSaved().catch(() => {});
} catch (error) {
  $('#cards').innerHTML = '<p class="empty">Библиотека не загрузилась. Проверьте соединение и <button id="retry-catalog">повторите</button>.</p>';
  $('#retry-catalog').onclick = () => location.reload(); console.error(error);
}
