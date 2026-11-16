(() => {
  const HOST_ID = 'sitedoc-page-editor-host';
  document.getElementById(HOST_ID)?.remove();
  document.querySelectorAll('.sitedoc-page-check').forEach(node => node.remove());
  document.querySelectorAll('.sitedoc-page-toggle').forEach(button => {
    const li = button.closest('li');
    const nested = li && [...li.children].find(child => ['UL', 'OL'].includes(child.tagName));
    if (nested) nested.hidden = false;
    button.remove();
  });
  document.querySelectorAll('style[data-sitedoc-editor]').forEach(node => node.remove());

  const selectors = 'nav,[role="navigation"],.md-nav,.wy-nav-side,.toctree-wrapper,.sidebar,[class*="sidebar" i],[class*="navigation" i],[class*="menu" i]';
  let roots = [...document.querySelectorAll(selectors)];
  if (!roots.length) {
    roots = [...document.querySelectorAll('ul,ol')].filter(list =>
      /nav|menu|sidebar|tree|toc/i.test(`${list.className || ''} ${list.id || ''} ${list.parentElement?.className || ''}`) &&
      list.querySelectorAll('a[href]').length > 2
    );
  }
  roots = roots.filter((root, index) => !roots.some((other, otherIndex) => otherIndex !== index && other.contains(root)));
  if (!roots.length) { alert('SiteDoc не нашёл меню навигации на этой странице.'); return; }

  const canonical = value => {
    try { const url = new URL(value, location.href); url.hash = ''; if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, ''); return url.href; }
    catch { return ''; }
  };
  const records = [];
  const byAnchor = new Map();
  const byUrl = new Set();
  for (const root of roots) {
    for (const anchor of root.querySelectorAll('a[href]')) {
      if (records.length >= 1200) break;
      let url;
      try { url = new URL(anchor.href); } catch { continue; }
      const title = (anchor.textContent || anchor.getAttribute('aria-label') || anchor.title || '').trim().replace(/\s+/g, ' ');
      if (url.origin !== location.origin || !title || title.length > 180 || anchor.getAttribute('href')?.trim().startsWith('#') ||
          /\.(pdf|png|jpe?g|svg|zip|tar|gz|css|js)$/i.test(url.pathname)) continue;
      const key = canonical(url.href);
      if (byUrl.has(key)) continue;
      const record = { anchor, title, url: key, parent: null, children: [], checkbox: null };
      records.push(record); byAnchor.set(anchor, record); byUrl.add(key);
    }
  }
  if (!records.length) { alert('В меню не найдено подходящих страниц для выбора.'); return; }

  const directAnchor = li => {
    for (const child of li.children) {
      if (child.matches?.('a[href]')) return child;
      for (const anchor of child.querySelectorAll?.(':scope > a[href]') || []) return anchor;
    }
    return null;
  };
  for (const record of records) {
    let li = record.anchor.closest('li');
    let parentRecord = null;
    while (li && !parentRecord) {
      li = li.parentElement?.closest('li');
      const parentAnchor = li && directAnchor(li);
      parentRecord = parentAnchor ? byAnchor.get(parentAnchor) || null : null;
    }
    record.parent = parentRecord;
    if (parentRecord) parentRecord.children.push(record);
  }
  const topLevel = records.filter(record => !record.parent);

  const host = document.createElement('div'); host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial;position:fixed;inset:14px 14px 14px auto;z-index:2147483647;width:min(430px,calc(100vw - 28px));font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#19252c}
    *{box-sizing:border-box}.panel{height:100%;display:flex;flex-direction:column;padding:14px;border:1px solid #dce3df;border-radius:12px;background:#fff;box-shadow:0 8px 32px #16251d40}
    .head{display:flex;align-items:center;gap:8px;margin-bottom:6px}.head b{flex:1;font-size:14px}.head button,.tools button,.save{border:1px solid #dce3df;border-radius:7px;padding:6px 8px;background:#f4f7f5;color:#25332d;font:12px system-ui;cursor:pointer}
    .hint{margin:0 0 9px;font-size:11px;color:#718078}.tools{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px}.tree{min-height:0;flex:1;overflow:auto;border:1px solid #edf0ee;border-radius:8px;padding:5px}
    details{margin:2px 0}summary{display:flex;align-items:center;gap:6px;min-height:29px;list-style:none}summary::-webkit-details-marker{display:none}summary::before{content:'›';display:inline-block;width:12px;color:#698075}details[open]>summary::before{content:'⌄'}summary.leaf::before{content:''}
    input{flex:none;width:15px;height:15px;margin:0;accent-color:#216c55}summary label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;cursor:pointer}summary a{color:inherit;text-decoration:none}summary a:hover{color:#216c55;text-decoration:underline}.children{padding-left:17px}
    .save{flex:none;width:100%;margin-top:9px;padding:9px;background:#216c55;color:#fff;font-weight:650}.save:disabled{opacity:.55;cursor:not-allowed}.status{flex:none;min-height:18px;margin:7px 0 0;color:#52685c;font-size:11px}
    @media(max-width:520px){:host{inset:8px;width:calc(100vw - 16px)}}
  `;
  const panel = document.createElement('section'); panel.className = 'panel'; panel.setAttribute('aria-label', 'SiteDoc: выбор страниц');
  const header = document.createElement('div'); header.className = 'head';
  const heading = document.createElement('b'); heading.textContent = 'SiteDoc · выбор страниц';
  const exitButton = document.createElement('button'); exitButton.type = 'button'; exitButton.textContent = '×'; exitButton.title = 'Выйти из режима'; exitButton.setAttribute('aria-label', 'Выйти из режима');
  header.append(heading, exitButton);
  const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = 'Отмечайте страницы в меню SiteDoc. Галочка раздела выбирает всю вложенную ветку.';
  const tools = document.createElement('div'); tools.className = 'tools';
  const makeButton = (text, className) => { const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = text; return button; };
  tools.append(makeButton('Выбрать всё', 'all'), makeButton('Снять всё', 'none'), makeButton('Развернуть всё', 'expand'), makeButton('Свернуть всё', 'collapse'));
  const tree = document.createElement('div'); tree.className = 'tree'; tree.setAttribute('aria-label', 'Дерево страниц');
  const status = document.createElement('p'); status.className = 'status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const saveButton = makeButton('Сохранить выбранные страницы', 'save');
  panel.append(header, hint, tools, tree, saveButton, status); shadow.append(style, panel); document.documentElement.append(host);

  const checkboxRecords = new Map();
  const renderNode = (record, depth = 0) => {
    const details = document.createElement('details'); details.open = depth < 2; details.dataset.node = 'true';
    const summary = document.createElement('summary');
    if (!record.children.length) summary.classList.add('leaf');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.setAttribute('aria-label', `Выбрать ${record.title}`);
    record.checkbox = checkbox; checkboxRecords.set(checkbox, record);
    const label = document.createElement('label'); label.title = record.title;
    const link = document.createElement('a'); link.href = record.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = record.title; label.append(link);
    summary.append(checkbox, label); details.append(summary);
    if (record.children.length) {
      const children = document.createElement('div'); children.className = 'children';
      for (const child of record.children) children.append(renderNode(child, depth + 1));
      details.append(children);
    }
    return details;
  };
  for (const record of topLevel) tree.append(renderNode(record));
  if (records.length === 1200) hint.textContent = 'Показаны первые 1200 страниц меню. Выберите нужные пункты и запустите сохранение.';

  const updateStatus = () => {
    const checked = records.reduce((count, record) => count + (record.checkbox.checked ? 1 : 0), 0);
    status.textContent = `Отмечено ${checked} из ${records.length} страниц`;
    saveButton.disabled = checked === 0;
  };
  const setBranch = (record, checked) => {
    const stack = [record];
    while (stack.length) { const current = stack.pop(); current.checkbox.checked = checked; stack.push(...current.children); }
  };
  tree.addEventListener('change', event => {
    const record = checkboxRecords.get(event.target);
    if (!record) return;
    setBranch(record, event.target.checked);
    updateStatus();
  });
  tools.querySelector('.all').addEventListener('click', () => { for (const record of records) record.checkbox.checked = true; updateStatus(); });
  tools.querySelector('.none').addEventListener('click', () => { for (const record of records) record.checkbox.checked = false; updateStatus(); });
  tools.querySelector('.expand').addEventListener('click', () => { for (const node of tree.querySelectorAll('details')) node.open = true; });
  tools.querySelector('.collapse').addEventListener('click', () => { for (const node of tree.querySelectorAll('details')) node.open = false; });
  exitButton.addEventListener('click', () => host.remove());
  saveButton.addEventListener('click', async () => {
    const selected = records.filter(record => record.checkbox.checked);
    if (!selected.length) return;
    saveButton.disabled = true; status.textContent = 'Запускаю сохранение…';
    try {
      const { collections = [], selectedCollectionId } = await chrome.storage.local.get(['collections', 'selectedCollectionId']);
      if (!collections.some(item => item.id === selectedCollectionId)) throw new Error('Сначала выберите или создайте библиотеку в SiteDoc.');
      const items = selected.map(record => {
        const navPath = []; let parent = record.parent;
        while (parent) { navPath.unshift({ title: parent.title, url: parent.url }); parent = parent.parent; }
        return { url: record.url, title: record.title, navPath, breadcrumbs: navPath, depth: navPath.length };
      });
      const result = await chrome.runtime.sendMessage({ type: 'START_SECTION_IMPORT', items, collectionId: selectedCollectionId, updateExisting: false });
      if (result?.error) throw new Error(result.error);
      status.textContent = `Сохранение ${items.length} страниц запущено в фоне. Панель можно закрыть.`;
    } catch (error) { status.textContent = `Не удалось запустить сохранение: ${error.message}`; updateStatus(); }
  });
  updateStatus();
})();
