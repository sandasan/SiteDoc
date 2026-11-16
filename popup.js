const select = document.querySelector('#collection');
const status = document.querySelector('#status');
const read = (keys) => chrome.storage.local.get(keys);

async function init() {
  const { collections = [] } = await read(['collections']);
  if (!collections.length) {
    const first = { id: crypto.randomUUID(), title: 'Моя библиотека', items: [] };
    await chrome.storage.local.set({ collections: [first] }); collections.push(first);
  }
  select.innerHTML = collections.map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join('');
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

document.querySelector('#save').addEventListener('click', async () => {
  status.textContent = 'Сохраняю страницу…';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const [page] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => {
      const root = document.querySelector('main, article, [role="main"]') || document.body;
      const copy = root.cloneNode(true);
      copy.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,button,[role="navigation"],.advertisement,.ads').forEach(n => n.remove());
      const usedIds = new Set([...copy.querySelectorAll('[id]')].map(node => node.id));
      const headings = [...copy.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((heading, index) => {
        if (!heading.id) {
          const base = `sitedoc-heading-${index + 1}`;
          let id = base, suffix = 1;
          while (usedIds.has(id)) id = `${base}-${++suffix}`;
          heading.id = id; usedIds.add(id);
        }
        return { id: heading.id, title: (heading.innerText || heading.textContent || '').trim(), level: Number(heading.tagName.slice(1)) };
      }).filter(heading => heading.title);

      // Inline images so EPUB reading does not depend on the source site remaining online.
      let embeddedBytes = 0;
      const toDataUrl = async source => {
        const response = await fetch(source, { credentials: 'include' });
        if (!response.ok) return null;
        const blob = await response.blob();
        if (embeddedBytes + blob.size > 2_000_000) return null;
        embeddedBytes += blob.size;
        return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => resolve(null); reader.readAsDataURL(blob); });
      };
      await Promise.all([...copy.querySelectorAll('img')].map(async image => {
        const rawSource = image.currentSrc || image.getAttribute('src') || image.getAttribute('data-src');
        if (!rawSource) return;
        const source = new URL(rawSource, location.href).href;
        image.setAttribute('src', source);
        image.removeAttribute('srcset');
        try { const data = await toDataUrl(source); if (data) image.setAttribute('src', data); }
        catch { /* Cross-origin images that disallow fetching stay as source URLs. */ }
      }));

      // CSSOM exposes rules for same-origin and CORS-enabled stylesheets. Keep source URLs
      // for inaccessible stylesheets as graceful online fallbacks.
      const styles = [];
      for (const sheet of document.styleSheets) {
        try {
          let css = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
          const imageUrls = [...new Set([...css.matchAll(/url\([\"']?([^\"')]+)[\"']?\)/gi)].map(match => match[1]).filter(url => !url.startsWith('data:') && !url.startsWith('#')))];
          for (const source of imageUrls) {
            try {
              const absolute = new URL(source, sheet.href || location.href).href;
              const data = await toDataUrl(absolute);
              if (data) css = css.split(source).join(data);
              else css = css.split(source).join(absolute);
            } catch { /* Keep unresolved CSS asset references absolute. */ }
          }
          styles.push({ href: sheet.href || location.href, css });
        } catch {
          if (sheet.href) styles.push({ href: sheet.href, css: `@import url("${sheet.href.replaceAll('"', '%22')}");` });
        }
      }
      return { title: document.title, url: location.href, html: copy.innerHTML, text: copy.innerText || copy.textContent || '', headings, styles, siteTitle: document.querySelector('meta[property="og:site_name"]')?.content || location.hostname };
    } });
    const data = page.result;
    const { collections = [] } = await read(['collections']);
    const collection = collections.find(c => c.id === select.value);
    if (!collection) throw new Error('Коллекция не найдена');
    const id = crypto.randomUUID();
    collection.items.push({ id, parentId: null, title: data.title || data.url, url: data.url, siteTitle: data.siteTitle, html: data.html, text: data.text, headings: data.headings || [], styles: data.styles || [], addedAt: Date.now() });
    await chrome.storage.local.set({ collections });
    status.textContent = `Добавлено: ${data.title}`;
  } catch (e) { status.textContent = `Не удалось сохранить страницу: ${e.message}`; }
});
init();
