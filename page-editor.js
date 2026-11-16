(() => {
  const HOST_ID = 'sitedoc-page-editor-host';
  if (document.getElementById(HOST_ID)) return;

  const navRoots = [...document.querySelectorAll('nav,[role="navigation"],.md-nav,.wy-nav-side,.sidebar,.toctree-wrapper')];
  const roots = navRoots.length ? navRoots : [document.body];
  const anchors = [...new Set(roots.flatMap(root => [...root.querySelectorAll('a[href]')]))].filter(anchor => {
    try {
      const url = new URL(anchor.href);
      return url.origin === location.origin && !anchor.getAttribute('href')?.trim().startsWith('#') &&
        !/\.(pdf|png|jpe?g|svg|zip|tar|gz|css|js)$/i.test(url.pathname) &&
        (anchor.textContent || anchor.getAttribute('aria-label') || '').trim();
    } catch { return false; }
  });
  if (!anchors.length) { alert('SiteDoc не нашёл меню со ссылками на этой странице.'); return; }

  const canonical = value => { try { const url = new URL(value, location.href); url.hash = ''; if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, ''); return url.href; } catch { return ''; } };
  const records = [];
  const originalHidden = new Map();
  const nestedOwners = new Map();
  const style = document.createElement('style');
  style.dataset.sitedocEditor = 'true';
  style.textContent = `
    .sitedoc-page-check{appearance:auto!important;display:inline-block!important;position:static!important;opacity:1!important;visibility:visible!important;width:15px!important;height:15px!important;margin:0 5px 0 2px!important;vertical-align:middle!important;accent-color:#216c55!important;z-index:2147483646!important}
    .sitedoc-page-toggle{display:inline-block!important;position:static!important;width:auto!important;height:auto!important;margin:0 4px!important;padding:0 4px!important;border:1px solid #b8c9bf!important;border-radius:4px!important;background:#f4f8f5!important;color:#216c55!important;font:12px/1.4 system-ui,sans-serif!important;vertical-align:middle!important;cursor:pointer!important;z-index:2147483646!important}
  `;
  document.documentElement.append(style);

  for (const anchor of anchors) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.className = 'sitedoc-page-check';
    checkbox.setAttribute('aria-label', `Выбрать страницу ${anchor.textContent.trim()}`);
    const li = anchor.closest('li');
    const nested = li && [...li.children].find(child => ['UL', 'OL'].includes(child.tagName));
    let toggle = null;
    if (nested) {
      if (!originalHidden.has(nested)) originalHidden.set(nested, nested.hidden);
      toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'sitedoc-page-toggle';
      toggle.textContent = nested.hidden ? '+' : '−'; toggle.title = nested.hidden ? 'Развернуть подраздел' : 'Свернуть подраздел';
      toggle.addEventListener('click', () => { nested.hidden = !nested.hidden; toggle.textContent = nested.hidden ? '+' : '−'; toggle.title = nested.hidden ? 'Развернуть подраздел' : 'Свернуть подраздел'; });
      nestedOwners.set(nested, toggle);
      anchor.before(toggle);
    }
    anchor.before(checkbox);
    const lineage = [];
    let parent = li?.parentElement?.closest('li');
    while (parent) {
      const parentAnchor = [...parent.children].flatMap(child => child.matches?.('a[href]') ? [child] : [...(child.querySelectorAll?.(':scope > a[href]') || [])])[0];
      if (parentAnchor) lineage.unshift({ title: (parentAnchor.textContent || '').trim(), url: parentAnchor.href });
      parent = parent.parentElement?.closest('li');
    }
    const label = (anchor.textContent || anchor.getAttribute('aria-label') || anchor.title || '').trim().replace(/\s+/g, ' ');
    const record = { anchor, checkbox, toggle, li, title: label, url: canonical(anchor.href), navPath: lineage };
    records.push(record);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked && li) for (const child of records) if (child !== record && li.contains(child.anchor)) child.checkbox.checked = true;
      if (!checkbox.checked && li) for (const child of records) if (child !== record && li.contains(child.anchor)) child.checkbox.checked = false;
      updateStatus();
    });
  }

  const host = document.createElement('div'); host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#19252c}
    .panel{width:310px;padding:14px;border:1px solid #dce3df;border-radius:12px;background:#fff;box-shadow:0 8px 32px #16251d40}
    .head{display:flex;align-items:center;gap:8px;margin-bottom:10px}.head b{flex:1;font-size:14px}.head button{width:28px;padding:3px;font-size:18px}
    .tools{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px}.tools button,.save,.head button{border:1px solid #dce3df;border-radius:7px;padding:6px 8px;background:#f4f7f5;color:#25332d;font:12px system-ui;cursor:pointer}
    .save{width:100%;padding:9px;background:#216c55;color:#fff;font-weight:650}.save:disabled{opacity:.55;cursor:not-allowed}
    .status{min-height:18px;margin:8px 0 0;color:#52685c;font-size:11px}.hint{font-size:11px;color:#718078;margin:0 0 9px}
  </style><section class="panel" aria-label="SiteDoc: выбор страниц">
    <div class="head"><b>SiteDoc · выбор страниц</b><button class="exit" title="Выйти из режима" aria-label="Выйти из режима">×</button></div>
    <p class="hint">Отмечайте страницы в меню сайта. Галочка у раздела переключает всю вложенную ветку.</p>
    <div class="tools"><button class="all">Выбрать всё</button><button class="none">Снять всё</button><button class="expand">Развернуть всё</button><button class="collapse">Свернуть всё</button></div>
    <button class="save">Сохранить выбранные страницы</button><p class="status" role="status" aria-live="polite"></p>
  </section>`;
  document.documentElement.append(host);
  const $ = selector => shadow.querySelector(selector);
  const status = $('.status');
  const updateStatus = () => { const checked = records.filter(item => item.checkbox.checked).length; status.textContent = `Отмечено ${checked} из ${records.length} страниц`; $('.save').disabled = !checked; };
  const exit = () => {
    for (const record of records) { record.checkbox.remove(); record.toggle?.remove(); }
    for (const [node, hidden] of originalHidden) node.hidden = hidden;
    style.remove(); host.remove();
  };
  $('.exit').addEventListener('click', exit);
  $('.all').addEventListener('click', () => { records.forEach(item => item.checkbox.checked = true); updateStatus(); });
  $('.none').addEventListener('click', () => { records.forEach(item => item.checkbox.checked = false); updateStatus(); });
  $('.expand').addEventListener('click', () => { for (const [node] of originalHidden) { node.hidden = false; nestedOwners.get(node).textContent = '−'; } });
  $('.collapse').addEventListener('click', () => { for (const [node] of originalHidden) { node.hidden = true; nestedOwners.get(node).textContent = '+'; } });
  $('.save').addEventListener('click', async () => {
    const selected = records.filter(item => item.checkbox.checked);
    if (!selected.length) return;
    $('.save').disabled = true; status.textContent = 'Запускаю сохранение…';
    try {
      const { collections = [], selectedCollectionId } = await chrome.storage.local.get(['collections', 'selectedCollectionId']);
      if (!collections.some(item => item.id === selectedCollectionId)) throw new Error('Сначала выберите или создайте библиотеку в SiteDoc.');
      const items = selected.map(item => ({ url: item.url, title: item.title, navPath: item.navPath, breadcrumbs: item.navPath, depth: item.navPath.length }));
      const result = await chrome.runtime.sendMessage({ type: 'START_SECTION_IMPORT', items, collectionId: selectedCollectionId, updateExisting: false });
      if (result?.error) throw new Error(result.error);
      status.textContent = `Сохранение ${items.length} страниц запущено в фоне. Окно можно закрыть.`;
    } catch (error) { status.textContent = `Не удалось запустить сохранение: ${error.message}`; updateStatus(); }
  });
  updateStatus();
})();
