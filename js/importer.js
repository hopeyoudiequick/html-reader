// Reads a picked HTML file and turns it into a book. Each <section> of the file
// becomes a chapter (the Scribd tool starts a new section at every heading), and
// headings feed the table of contents. Anything that would fight the reader is
// dropped: scripts, the file's own toolbar and contents box, inline layout
// styles, forms, and images that point at files that are not in the book.

const DROP = [
  'script', 'style', 'link', 'meta', 'base', 'title', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea',
  'noscript', 'template',
  '#bar', '#toc', // toolbar and contents box written by the Scribd tool
].join(', ');

const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster']);

const KEEP_STYLES = new Set([
  'font-style', 'font-weight', 'font-variant', 'text-align', 'text-decoration',
  'text-indent', 'text-transform', 'letter-spacing', 'vertical-align', 'white-space',
]);

const probe = document.createElement('span');

export async function importBook(file) {
  const text = decodeHtml(new Uint8Array(await file.arrayBuffer()));
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const root = doc.querySelector('main') || doc.body;
  root.querySelectorAll(DROP).forEach((el) => el.remove());

  const chapters = [];
  const toc = [];
  const anchors = {};

  for (const nodes of splitChapters(root)) {
    const holder = doc.createElement('div');
    holder.append(...nodes);
    sanitize(holder);
    if (!/\S/.test(holder.textContent) && !holder.querySelector('img')) continue;

    const index = chapters.length;
    const headings = [];
    holder.querySelectorAll('h1, h2, h3').forEach((h) => {
      const t = clean(h.textContent);
      if (!t) return;
      if (!h.id) h.id = `rd-${index}-${headings.length + 1}`;
      headings.push({ t, lv: Number(h.tagName[1]), id: h.id });
    });

    // The chapter itself is listed under its first heading; the others are nested under it.
    const first = headings[0];
    const sectionId = holder.firstElementChild ? holder.firstElementChild.id : '';
    toc.push({
      t: first ? first.t : `Capitolo ${index + 1}`,
      c: index,
      lv: 1,
      id: first ? first.id : (sectionId || null),
    });
    headings.slice(1).forEach((h) => toc.push({ t: h.t, c: index, lv: h.lv, id: h.id }));

    holder.querySelectorAll('[id]').forEach((el) => {
      anchors[el.id] = index;
    });
    chapters.push(holder.innerHTML);
  }

  if (!chapters.length) throw new Error('non contiene testo leggibile');

  const title = clean(doc.title) || (toc[0] && toc[0].t) || file.name.replace(/\.[^.]+$/, '');
  return {
    meta: {
      id: newId(),
      title,
      lang: doc.documentElement.getAttribute('lang') || 'en',
      addedAt: Date.now(),
      chapterCount: chapters.length,
      toc,
      anchors,
    },
    chapters,
  };
}

// Top-level <section> elements are chapters. Loose content between them becomes one chapter too.
function splitChapters(root) {
  const groups = [];
  let loose = null;
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeName === 'SECTION') {
      groups.push([node]);
      loose = null;
    } else if (node.nodeType === Node.ELEMENT_NODE || (node.nodeType === Node.TEXT_NODE && /\S/.test(node.data))) {
      if (!loose) {
        loose = [];
        groups.push(loose);
      }
      loose.push(node);
    }
  }
  return groups;
}

function sanitize(root) {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (el.tagName === 'IMG' && !/^(data:|https?:|blob:)/i.test(el.getAttribute('src') || '')) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'target') {
        el.removeAttribute(attr.name);
      } else if (URL_ATTRS.has(name) && /^\s*(javascript|vbscript):/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      } else if (name === 'style') {
        keepStyle(el, attr.value);
      }
    }
  }
}

// Keeps only the inline styles that express the text itself (italics, alignment...).
// Elements the source hides are removed, so they never take up room in the text.
function keepStyle(el, css) {
  probe.setAttribute('style', css);
  const style = probe.style;
  if (style.display === 'none' || style.visibility === 'hidden') {
    el.remove();
    return;
  }
  const kept = Array.from(style)
    .filter((prop) => KEEP_STYLES.has(prop))
    .map((prop) => `${prop}: ${style.getPropertyValue(prop)}`);
  if (kept.length) el.setAttribute('style', kept.join('; '));
  else el.removeAttribute('style');
}

function decodeHtml(bytes) {
  // Honour <meta charset>. The declaration is read as windows-1252, which leaves
  // the ASCII of the tags intact whatever the real encoding of the file is.
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 2048));
  const match = head.match(/charset\s*=\s*["']?\s*([\w-]+)/i);
  try {
    return new TextDecoder(match ? match[1] : 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
