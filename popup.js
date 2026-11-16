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
    const [page] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { const root = document.querySelector('main, article, [role="main"]') || document.body; const copy = root.cloneNode(true); copy.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,button,[role="navigation"],.advertisement,.ads').forEach(n => n.remove()); return { title: document.title, url: location.href, html: copy.innerHTML, text: copy.innerText || copy.textContent || '', siteTitle: document.querySelector('meta[property="og:site_name"]')?.content || location.hostname }; } });
    const data = page.result;
    const { collections = [] } = await read(['collections']);
    const collection = collections.find(c => c.id === select.value);
    if (!collection) throw new Error('Коллекция не найдена');
    const id = crypto.randomUUID();
    collection.items.push({ id, parentId: null, title: data.title || data.url, url: data.url, siteTitle: data.siteTitle, html: data.html, text: data.text, addedAt: Date.now() });
    await chrome.storage.local.set({ collections });
    status.textContent = `Добавлено: ${data.title}`;
  } catch (e) { status.textContent = `Не удалось сохранить страницу: ${e.message}`; }
});
init();
