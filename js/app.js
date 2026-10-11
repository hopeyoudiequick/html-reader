// The app: library, reading controls, gestures, settings and saving.
import * as store from './storage.js';
import { importBook } from './importer.js';
import { Reader } from './reader.js';

const FONTS = {
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  charter: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
  georgia: 'Georgia, "Times New Roman", serif',
  sans: '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
};

// [horizontal, vertical] distance from the screen edges, in px
const MARGINS = { small: [14, 14], medium: [22, 22], large: [32, 30] };

const DEFAULTS = {
  theme: 'dark', // the status bar text is white, so a dark page keeps the clock readable
  font: 'serif',
  fontSize: 19,
  lineHeight: 1.6,
  margin: 'medium',
  justify: false,
  brightness: 100,
  mode: 'pages',
  immersive: false,
  resume: true,
  keepAwake: true,
};

const BARS_MS = 4000;
const CENTER_DOUBLE_TAP_MS = 400;

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const els = {
  library: $('library'),
  reader: $('reader'),
  view: $('rd-view'),
  list: $('book-list'),
  empty: $('empty'),
  seek: $('seek'),
  backdrop: $('sheet-backdrop'),
  sheet: $('sheet'),
  busy: $('busy'),
  hairline: $('hairline').firstElementChild,
};

let settings = { ...DEFAULTS, ...store.getSettings() };
let book = null; // metadata of the book being read
let barsOn = false;
let barsTimer = 0;
let lastCenterTap = 0;
let seeking = false;
let saveTimer = 0;
let toastTimer = 0;
let wakeLock = null;

const reader = new Reader({
  view: els.view,
  stage: $('rd-stage'),
  content: $('rd-content'),
  loadChapter: (index) => (book ? store.getChapterHtml(book.id, index) : ''),
  onChange: onReaderChange,
});

const go = (step) => step().catch((err) => console.error(err));

// ---------- Views ----------

function showView(name) {
  els.library.hidden = name !== 'library';
  els.reader.hidden = name !== 'reader';
}

async function openBook(meta) {
  book = meta;
  store.setLastBookId(meta.id);
  $('bar-book').textContent = meta.title;
  showView('reader');
  applySettings();
  setBars(false);
  const start = store.getProgress(meta.id) || { chapter: 0, offset: 0 };
  try {
    await reader.open(meta, start);
  } catch (err) {
    console.error(err);
    toast('Non riesco ad aprire questo libro.');
    await closeBook();
  }
}

async function closeBook() {
  saveNow();
  store.setLastBookId(null);
  closeSheet();
  setBars(false);
  setWakeLock(false);
  book = null;
  showView('library');
  await renderLibrary();
}

// ---------- Library ----------

const lastActivity = (meta) => (store.getProgress(meta.id) || {}).at || meta.addedAt;

async function renderLibrary() {
  let books = [];
  try {
    books = await store.listBooks();
  } catch (err) {
    console.error(err);
    toast('Non riesco a leggere la libreria.');
  }
  books.sort((a, b) => lastActivity(b) - lastActivity(a));
  els.list.replaceChildren(...books.map(bookCard));
  els.empty.hidden = books.length > 0;
}

function bookCard(meta) {
  const prog = store.getProgress(meta.id);
  const pct = Math.round(((prog && prog.pct) || 0) * 100);

  const item = document.createElement('li');
  item.className = 'book';

  const track = document.createElement('div');
  track.className = 'track';
  const fill = document.createElement('i');
  fill.style.width = `${pct}%`;
  track.append(fill);

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'book-open';
  open.append(
    textEl('div', 'book-title', meta.title),
    textEl('div', 'book-meta', `${meta.chapterCount} capitoli · ${pct}% letto`),
    track
  );
  open.onclick = () => openBook(meta);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'book-del';
  del.setAttribute('aria-label', `Elimina ${meta.title}`);
  del.textContent = '×';
  del.onclick = () => removeBook(meta);

  item.append(open, del);
  return item;
}

function textEl(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

async function removeBook(meta) {
  if (!confirm(`Eliminare «${meta.title}» dalla libreria? Si cancella anche il segnalibro.`)) return;
  try {
    await store.deleteBook(meta.id);
    store.forgetProgress(meta.id);
    toast('Libro eliminato');
  } catch (err) {
    console.error(err);
    toast('Eliminazione non riuscita.');
  }
  await renderLibrary();
}

async function importFiles(files) {
  els.busy.hidden = false;
  let added = 0;
  try {
    for (const file of files) {
      try {
        const { meta, chapters } = await importBook(file);
        await store.saveBook(meta, chapters);
        added += 1;
      } catch (err) {
        console.error(err);
        toast(`«${file.name}» non si può importare: ${err.message}`);
      }
    }
  } finally {
    els.busy.hidden = true;
  }
  if (added) toast(added === 1 ? 'Libro aggiunto' : `${added} libri aggiunti`);
  await renderLibrary();
}

$('btn-add').onclick = () => $('file-input').click();
$('file-input').onchange = (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) importFiles(files);
};

// ---------- Reading: progress, bars and saving ----------

function onReaderChange(info) {
  els.hairline.style.width = `${(info.book * 100).toFixed(2)}%`;
  if (barsOn) updateBars(info);
  scheduleSave();
}

function updateBars(info) {
  if (!seeking) els.seek.value = String(Math.round(info.local * 1000));
  const pages = settings.mode === 'pages' ? ` · ${info.page + 1}/${info.pageCount}` : '';
  $('bar-progress').textContent = `Cap. ${info.chapter + 1}/${info.chapterCount} · ${Math.round(info.book * 100)}%${pages}`;
  const section = reader.currentSection(book.toc);
  const name = section >= 0 ? book.toc[section].t : '';
  $('bar-section').textContent = name === book.title ? '' : name;
}

function setBars(on) {
  barsOn = on && !settings.immersive;
  els.reader.classList.toggle('bars-on', barsOn);
  clearTimeout(barsTimer);
  if (barsOn) {
    updateBars(reader.info());
    barsTimer = setTimeout(() => setBars(false), BARS_MS);
  }
}

function keepBarsOpen() {
  if (!barsOn) return;
  clearTimeout(barsTimer);
  barsTimer = setTimeout(() => setBars(false), BARS_MS);
}

// The position is written a moment after the last change, so a quick run of
// page turns costs one write. It is also written when the app goes away.
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

function saveNow() {
  clearTimeout(saveTimer);
  if (!book || els.reader.hidden) return;
  const pos = reader.position();
  if (pos) store.setProgress(book.id, pos);
}

// ---------- Gestures ----------

let press = null;

function clearSelection() {
  const selection = window.getSelection();
  if (selection) selection.removeAllRanges();
}

els.view.addEventListener('pointerdown', (e) => {
  press = {
    id: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    lastX: e.clientX,
    lastY: e.clientY,
    t: performance.now(),
    onLink: !!e.target.closest('a'),
  };
});

// The last position is kept because the browser can cancel a drag before its pointerup.
els.view.addEventListener('pointermove', (e) => {
  if (press && e.pointerId === press.id) {
    press.lastX = e.clientX;
    press.lastY = e.clientY;
  }
});

els.view.addEventListener('pointerup', (e) => {
  if (!press || e.pointerId !== press.id) return;
  const p = press;
  press = null;
  gesture(p, e.clientX, e.clientY, false);
});

els.view.addEventListener('pointercancel', (e) => {
  if (!press || e.pointerId !== press.id) return;
  const p = press;
  press = null;
  gesture(p, p.lastX, p.lastY, true);
});

// Works out what a press was: a swipe (page turn), a tap (zones of the page), or nothing.
function gesture(p, x, y, cancelled) {
  const dx = x - p.x;
  const dy = y - p.y;
  if (Math.abs(dx) > 40 && Math.abs(dx) > 1.5 * Math.abs(dy)) {
    clearSelection();
    if (settings.mode === 'pages') go(() => (dx < 0 ? reader.next() : reader.prev()));
    return;
  }
  if (cancelled) return; // without a swipe, a cancelled press is not a tap
  if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return; // a drag, not a tap
  if (performance.now() - p.t > 600 || p.onLink) return; // long press: text selection; links: the reader

  const selection = window.getSelection();
  if (selection && selection.toString()) {
    clearSelection(); // a tap only clears a selection
    return;
  }
  const zone = x / window.innerWidth;
  if (zone < 0.32) go(() => reader.prev());
  else if (zone > 0.68) go(() => reader.next());
  else onCenterTap();
}

// A tap in the middle shows or hides the bars. In immersive mode the bars never
// appear, and a double tap in the middle opens the menu instead.
function onCenterTap() {
  if (!settings.immersive) {
    setBars(!barsOn);
    return;
  }
  const now = Date.now();
  if (now - lastCenterTap < CENTER_DOUBLE_TAP_MS) {
    lastCenterTap = 0;
    openSheet('toc');
  } else {
    lastCenterTap = now;
  }
}

$('bar-top').addEventListener('pointerdown', keepBarsOpen);
$('bar-bottom').addEventListener('pointerdown', keepBarsOpen);
els.seek.addEventListener('pointerdown', () => {
  seeking = true;
  keepBarsOpen();
});
document.addEventListener('pointerup', () => {
  seeking = false;
});
els.seek.addEventListener('input', () => reader.seek(els.seek.value / 1000));

$('btn-back').onclick = () => closeBook();
$('btn-home').onclick = () => closeBook();
$('btn-menu').onclick = () => openSheet('settings');
$('btn-toc').onclick = () => openSheet('toc');

document.addEventListener('keydown', (e) => {
  if (els.reader.hidden || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === 'Escape') closeSheet();
  else if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) {
    e.preventDefault();
    go(() => reader.next());
  } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) {
    e.preventDefault();
    go(() => reader.prev());
  }
});

// ---------- Sheet: contents and settings ----------

function openSheet(tab) {
  setBars(false);
  showTab(tab);
  syncSettingsUI();
  els.backdrop.hidden = false;
  els.sheet.classList.add('open');
}

function closeSheet() {
  els.sheet.classList.remove('open');
  els.backdrop.hidden = true;
}

els.backdrop.onclick = () => closeSheet();

function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('on', tab.dataset.tab === name);
  }
  $('pane-toc').hidden = name !== 'toc';
  $('pane-settings').hidden = name !== 'settings';
  if (name === 'toc') renderToc();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => showTab(tab.dataset.tab);
}

function renderToc() {
  const current = reader.currentSection(book.toc);
  const items = book.toc.map((entry, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = entry.t;
    btn.style.paddingLeft = `${6 + (entry.lv - 1) * 16}px`;
    if (i === current) btn.classList.add('current');
    btn.onclick = () => {
      closeSheet();
      go(() => reader.goToEntry(entry));
    };
    li.append(btn);
    return li;
  });
  const list = $('toc-list');
  list.replaceChildren(...items);
  const active = list.querySelector('.current');
  if (active) active.scrollIntoView({ block: 'center' });
}

// Applies the settings to the page: CSS variables, layout mode, immersion, screen wake.
function applySettings() {
  const style = document.documentElement.style;
  const [mx, my] = MARGINS[settings.margin];
  document.documentElement.dataset.theme = settings.theme;
  style.setProperty('--fs', `${settings.fontSize}px`);
  style.setProperty('--lh', String(settings.lineHeight));
  style.setProperty('--ff', FONTS[settings.font]);
  style.setProperty('--mx', `${mx}px`);
  style.setProperty('--my', `${my}px`);
  style.setProperty('--align', settings.justify ? 'justify' : 'left');
  $('rd-dim').style.opacity = String(((100 - settings.brightness) / 100) * 0.85);
  els.reader.classList.toggle('immersive', settings.immersive);
  if (settings.immersive) setBars(false);
  reader.setMode(settings.mode);
  if (!els.reader.hidden) setWakeLock(settings.keepAwake);
}

function syncSettingsUI() {
  $('fs-val').textContent = String(settings.fontSize);
  $('set-font').value = settings.font;
  $('set-lh').value = String(settings.lineHeight);
  $('lh-val').textContent = settings.lineHeight.toFixed(2);
  $('set-justify').checked = settings.justify;
  $('set-brightness').value = String(settings.brightness);
  $('br-val').textContent = `${settings.brightness}%`;
  $('set-immersive').checked = settings.immersive;
  $('set-resume').checked = settings.resume;
  $('set-awake').checked = settings.keepAwake;
  for (const group of document.querySelectorAll('.seg[data-key]')) {
    for (const btn of group.children) {
      btn.setAttribute('aria-pressed', String(btn.dataset.value === settings[group.dataset.key]));
    }
  }
}

// The reading position is measured before the change, while the old layout is
// still on screen, and the text is brought back to the same place afterwards.
function update(patch) {
  const at = reader.currentOffset();
  settings = { ...settings, ...patch };
  store.saveSettings(settings);
  applySettings();
  reader.relayout(at);
  syncSettingsUI();
}

$('fs-dec').onclick = () => update({ fontSize: clamp(settings.fontSize - 1, 14, 30) });
$('fs-inc').onclick = () => update({ fontSize: clamp(settings.fontSize + 1, 14, 30) });
$('set-font').onchange = (e) => update({ font: e.target.value });
$('set-lh').oninput = (e) => update({ lineHeight: Number(e.target.value) });
$('set-justify').onchange = (e) => update({ justify: e.target.checked });
$('set-brightness').oninput = (e) => update({ brightness: Number(e.target.value) });
$('set-immersive').onchange = (e) => update({ immersive: e.target.checked });
$('set-resume').onchange = (e) => update({ resume: e.target.checked });
$('set-awake').onchange = (e) => update({ keepAwake: e.target.checked });

for (const group of document.querySelectorAll('.seg[data-key]')) {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (btn) update({ [group.dataset.key]: btn.dataset.value });
  });
}

// ---------- Screen, lifecycle and feedback ----------

// Keeps the screen on while reading, if the phone allows it (iOS 16.4 and later).
async function setWakeLock(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } else if (!on && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch {
    // Not supported or refused: the screen simply locks as usual.
  }
}

// iOS can suspend or close the app at any moment, so the position is saved
// as soon as the page is hidden, not only after the debounce.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
  else if (!els.reader.hidden && settings.keepAwake) setWakeLock(true);
});
window.addEventListener('pagehide', saveNow);

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function registerServiceWorker() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker non attivo', err));
  }
}

// On launch, go straight back to the book that was open, at the saved position.
async function init() {
  registerServiceWorker();
  applySettings();
  const last = store.getLastBookId();
  if (settings.resume && last) {
    const meta = await store.getBook(last).catch(() => undefined);
    if (meta) {
      await openBook(meta);
      return;
    }
  }
  showView('library');
  await renderLibrary();
}

init();
