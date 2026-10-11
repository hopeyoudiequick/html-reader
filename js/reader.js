// The reading engine. It shows one chapter at a time, either as horizontal pages
// (CSS multi-column, turned with a transform) or as a vertical scroll. A position
// is a character offset into the chapter's text rather than a page number, so it
// survives changes of font, size, margins and orientation.

const GAP = 56; // space between two columns in px; only used for the page arithmetic

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export class Reader {
  constructor({ view, stage, content, loadChapter, onChange }) {
    this.view = view;
    this.stage = stage;
    this.content = content;
    this.loadChapter = loadChapter; // (index) => Promise<html string>
    this.onChange = onChange; // (info) => void

    this.book = null;
    this.chapter = 0;
    this.page = 0;
    this.pageCount = 1;
    this.stride = 1;
    this.text = { nodes: [], starts: [], total: 0, index: new Map() };
    this.anchorCache = new Map();
    this.busy = false;
    this.token = 0;
    this.relayoutFrame = 0;
    this.emitFrame = 0;

    // Images decode after the first layout, so lay out again when they arrive.
    content.addEventListener(
      'load',
      (e) => {
        if (e.target.tagName === 'IMG') this.scheduleRelayout();
      },
      true
    );
    content.addEventListener('click', (e) => this.onClick(e));
    stage.addEventListener('scroll', () => this.scheduleEmit(), { passive: true });
    window.addEventListener('resize', () => this.scheduleRelayout());
  }

  get mode() {
    return this.view.classList.contains('mode-scroll') ? 'scroll' : 'pages';
  }

  isShown() {
    return this.view.offsetWidth > 0;
  }

  // Only switches the mode classes; the caller lays out again (see relayout).
  setMode(mode) {
    this.view.classList.toggle('mode-scroll', mode === 'scroll');
    this.view.classList.toggle('mode-pages', mode !== 'scroll');
  }

  async open(book, start) {
    this.book = book;
    await this.goTo(start.chapter ?? 0, { offset: start.offset ?? 0 });
  }

  // Loads a chapter and places the reader at an offset, at an anchor, or at its end.
  async goTo(index, { offset = 0, anchor = null, toEnd = false } = {}) {
    if (!this.book) return;
    const token = ++this.token;
    const target = clamp(index, 0, this.book.chapterCount - 1);
    this.busy = true;
    try {
      const html = await this.loadChapter(target);
      if (token !== this.token) return; // a newer request has taken over
      this.showChapter(target, html);
      if (toEnd) {
        this.toEnd();
      } else {
        const at = anchor !== null ? this.anchorOffset(anchor) : null;
        this.placeAt(at ?? offset);
      }
      this.emit();
    } finally {
      if (token === this.token) this.busy = false;
    }
  }

  showChapter(index, html) {
    this.chapter = index;
    this.anchorCache.clear();
    this.content.lang = this.book.lang || 'en';
    this.content.innerHTML = html;
    this.indexText();
    this.stage.scrollTop = 0;
    this.page = 0;
    this.layout();
  }

  toEnd() {
    if (this.mode === 'pages') this.setPage(this.pageCount - 1, false);
    else this.stage.scrollTop = this.stage.scrollHeight;
  }

  // Sizes the content for the current stage. In pages mode the content is one
  // tall box whose text flows into columns exactly one stage wide.
  layout() {
    const c = this.content;
    const w = Math.floor(this.stage.clientWidth);
    const h = Math.floor(this.stage.clientHeight);
    c.style.transition = 'none';
    c.style.transform = 'none';
    c.style.width = `${w}px`;
    c.style.setProperty('--stage-h', `${h}px`);
    if (this.mode === 'pages') {
      this.stride = w + GAP;
      c.style.height = `${h}px`;
      c.style.columnWidth = `${w}px`;
      c.style.columnGap = `${GAP}px`;
      c.style.columnFill = 'auto'; // fill each column to the bottom before starting the next one
      // Columns past the first one overflow the box, so scrollWidth counts them.
      const overflow = c.scrollWidth;
      this.pageCount = Math.max(1, Math.round((overflow + GAP) / this.stride));
      this.page = clamp(this.page, 0, this.pageCount - 1);
      this.applyTransform(false);
    } else {
      c.style.height = '';
      c.style.columnWidth = '';
      c.style.columnGap = '';
      c.style.columnFill = '';
      this.pageCount = 1;
      this.page = 0;
    }
  }

  applyTransform(animate) {
    const c = this.content;
    c.style.transition = animate ? 'transform 0.18s ease-out' : 'none';
    c.style.transform = this.mode === 'pages' ? `translate3d(${-this.page * this.stride}px, 0, 0)` : 'none';
  }

  setPage(page, animate = true) {
    this.page = clamp(page, 0, this.pageCount - 1);
    this.applyTransform(animate);
    this.emit();
  }

  // Puts the text at this offset at the top of the screen.
  placeAt(offset) {
    if (this.mode === 'pages') {
      const base = this.content.getBoundingClientRect().left;
      this.page = clamp(this.columnOf(offset, base), 0, this.pageCount - 1);
      this.applyTransform(false);
    } else {
      const rect = this.rectAt(offset);
      if (rect) this.stage.scrollTop += rect.top - this.stage.getBoundingClientRect().top;
    }
  }

  // Lays out again, keeping the same text on screen. `at` must be measured before
  // the change, while the old layout is still on screen; by default it is measured now.
  relayout(at = this.currentOffset()) {
    if (!this.book || this.busy || !this.isShown()) return;
    this.layout();
    if (at !== null) this.placeAt(at);
    this.emit();
  }

  scheduleRelayout() {
    if (this.relayoutFrame) return;
    this.relayoutFrame = requestAnimationFrame(() => {
      this.relayoutFrame = 0;
      this.relayout();
    });
  }

  scheduleEmit() {
    if (this.emitFrame) return;
    this.emitFrame = requestAnimationFrame(() => {
      this.emitFrame = 0;
      this.emit();
    });
  }

  emit() {
    if (this.book && this.onChange) this.onChange(this.info());
  }

  async next() {
    if (!this.book || this.busy) return;
    if (this.mode === 'pages') {
      if (this.page < this.pageCount - 1) return this.setPage(this.page + 1);
    } else if (this.stage.scrollHeight - this.stage.clientHeight - this.stage.scrollTop > 2) {
      this.stage.scrollTop += this.stage.clientHeight * 0.9;
      return;
    }
    if (this.chapter < this.book.chapterCount - 1) await this.goTo(this.chapter + 1);
  }

  async prev() {
    if (!this.book || this.busy) return;
    if (this.mode === 'pages') {
      if (this.page > 0) return this.setPage(this.page - 1);
    } else if (this.stage.scrollTop > 2) {
      this.stage.scrollTop -= this.stage.clientHeight * 0.9;
      return;
    }
    if (this.chapter > 0) await this.goTo(this.chapter - 1, { toEnd: true });
  }

  // fraction is 0..1 inside the current chapter
  seek(fraction) {
    if (!this.book) return;
    if (this.mode === 'pages') this.setPage(Math.round(fraction * (this.pageCount - 1)), false);
    else this.stage.scrollTop = fraction * (this.stage.scrollHeight - this.stage.clientHeight);
    this.emit();
  }

  // Where the reader is right now, for the status bar and the progress bar.
  info() {
    const count = this.book.chapterCount;
    let local;
    let read;
    if (this.mode === 'pages') {
      local = this.pageCount > 1 ? this.page / (this.pageCount - 1) : 0;
      read = (this.page + 1) / this.pageCount;
    } else {
      const max = this.stage.scrollHeight - this.stage.clientHeight;
      local = max > 0 ? this.stage.scrollTop / max : 0;
      read = this.stage.scrollHeight > 0 ? Math.min(1, (this.stage.scrollTop + this.stage.clientHeight) / this.stage.scrollHeight) : 1;
    }
    return {
      chapter: this.chapter,
      chapterCount: count,
      page: this.page,
      pageCount: this.pageCount,
      local,
      book: (this.chapter + read) / count,
    };
  }

  // The position to save, or null while the reader is hidden and nothing can be measured.
  position() {
    if (!this.book || !this.isShown()) return null;
    const offset = this.currentOffset();
    if (offset === null) return null;
    return { chapter: this.chapter, offset, pct: this.info().book };
  }

  // Index in the book's table of contents of the entry being read, or -1.
  currentSection(toc) {
    const at = this.currentOffset();
    if (at === null) return -1;
    let found = -1;
    toc.forEach((entry, i) => {
      if (entry.c !== this.chapter) return;
      const start = entry.id ? this.anchorOffset(entry.id) : 0;
      if (start !== null && start <= at) found = i;
    });
    return found;
  }

  goToEntry(entry) {
    if (entry.c === this.chapter) {
      const at = entry.id ? this.anchorOffset(entry.id) : 0;
      this.placeAt(at ?? 0);
      this.emit();
      return Promise.resolve();
    }
    return this.goTo(entry.c, { anchor: entry.id || null });
  }

  onClick(e) {
    const link = e.target.closest('a[href]');
    if (!link) return;
    e.preventDefault(); // never let a link navigate the app away from the book
    const href = link.getAttribute('href');
    if (/^https?:/i.test(href)) {
      window.open(href, '_blank', 'noopener');
    } else if (href.startsWith('#')) {
      this.followAnchor(safeDecode(href.slice(1)));
    }
  }

  followAnchor(id) {
    const at = this.anchorOffset(id);
    if (at !== null) {
      this.placeAt(at);
      this.emit();
      return;
    }
    const anchors = this.book.anchors || {};
    if (Object.prototype.hasOwnProperty.call(anchors, id)) {
      this.goTo(anchors[id], { anchor: id }).catch((err) => console.error(err));
    }
  }

  // ---- Offsets: text positions in the chapter, independent of the layout ----

  // The text nodes that take up room on screen, with the offset where each one starts.
  // Whitespace-only nodes between blocks are left out: they have no box to measure.
  indexText() {
    const nodes = [];
    const starts = [];
    const index = new Map();
    let total = 0;
    const walker = document.createTreeWalker(this.content, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!/\S/.test(n.data)) continue;
      index.set(n, nodes.length);
      nodes.push(n);
      starts.push(total);
      total += n.data.length;
    }
    this.text = { nodes, starts, total, index };
  }

  locate(offset) {
    const { nodes, starts } = this.text;
    if (!nodes.length) return null;
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { node: nodes[lo], pos: offset - starts[lo] };
  }

  // Screen box of the character at this offset.
  rectAt(offset) {
    const hit = this.locate(offset);
    if (!hit) return null;
    const start = clamp(hit.pos, 0, hit.node.data.length - 1);
    const range = document.createRange();
    range.setStart(hit.node, start);
    range.setEnd(hit.node, start + 1);
    return range.getBoundingClientRect();
  }

  // Column of the character at this offset, counted from the content's left edge.
  columnOf(offset, base) {
    const rect = this.rectAt(offset);
    if (!rect || (rect.width === 0 && rect.height === 0)) return -1;
    return Math.floor((rect.left - base + 4) / this.stride);
  }

  // The first offset for which the predicate turns true. Offsets are in reading
  // order, so the predicate changes from false to true only once.
  firstOffset(predicate) {
    let lo = 0;
    let hi = this.text.total;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (predicate(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  // Offset of the first character that is on screen at the top-left of the stage.
  currentOffset() {
    if (!this.book || !this.isShown()) return null;
    if (this.text.total === 0) return 0;
    if (this.mode === 'pages') {
      const base = this.content.getBoundingClientRect().left;
      return this.firstOffset((o) => this.columnOf(o, base) >= this.page);
    }
    const top = this.stage.getBoundingClientRect().top;
    return this.firstOffset((o) => {
      const rect = this.rectAt(o);
      return rect !== null && rect.bottom > top + 2;
    });
  }

  offsetOfElement(el) {
    const walker = document.createTreeWalker(this.content, NodeFilter.SHOW_TEXT);
    walker.currentNode = el;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = this.text.index.get(n);
      if (i !== undefined) return this.text.starts[i];
    }
    return this.text.total;
  }

  // Offset of the element with this id in the current chapter, or null.
  anchorOffset(id) {
    if (!this.anchorCache.has(id)) {
      let el = null;
      try {
        el = this.content.querySelector(`#${CSS.escape(id)}`);
      } catch {
        el = null;
      }
      this.anchorCache.set(id, el ? this.offsetOfElement(el) : null);
    }
    return this.anchorCache.get(id);
  }
}
