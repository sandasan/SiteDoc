const select = document.querySelector('#collection');
const status = document.querySelector('#status');
const preview = document.querySelector('#sectionPreview');
const sectionList = document.querySelector('#sectionLinks');
const addSelected = document.querySelector('#addSelected');
const selectAll = document.querySelector('#selectAll');
const selectedCount = document.querySelector('#selectedCount');
const createLibraryForm = document.querySelector('#createLibraryForm');
let candidatePages = new Map();
let collections = [];
const read = keys => chrome.storage.local.get(keys);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function init() {
  const saved = await read(['collections', 'selectedCollectionId']);
  collections = Array.isArray(saved.collections) ? saved.collections : [];
  if (!Array.isArray(saved.collections)) {
    const first = { id: crypto.randomUUID(), title: 'Моя библиотека', items: [] };
    collections = [first];
    saved.selectedCollectionId = first.id;
    await chrome.storage.local.set({ collections, selectedCollectionId: first.id });
  }
  const selectedId = collections.some(c => c.id === saved.selectedCollectionId) ? saved.selectedCollectionId : collections[0]?.id;
  renderLibrarySelect(selectedId);
  if (selectedId && selectedId !== saved.selectedCollectionId) await chrome.storage.local.set({ selectedCollectionId: selectedId });
}

function renderLibrarySelect(selectedId) {
  if (!collections.length) {
    select.innerHTML = '<option value="" selected>Сначала создайте библиотеку</option>';
    select.disabled = true;
  } else {
    select.innerHTML = collections.map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
    select.value = selectedId || collections[0].id;
    select.disabled = false;
  }
  document.querySelector('#save').disabled = !collections.length;
  document.querySelector('#findSection').disabled = !collections.length;
  document.querySelector('#deleteAllLibraries').disabled = !collections.length;
}

select.addEventListener('change', () => chrome.storage.local.set({ selectedCollectionId: select.value }));
document.querySelector('#showCreateLibrary').addEventListener('click', () => {
  createLibraryForm.hidden = !createLibraryForm.hidden;
  if (!createLibraryForm.hidden) document.querySelector('#libraryName').focus();
});
document.querySelector('#cancelCreateLibrary').addEventListener('click', () => {
  createLibraryForm.reset(); createLibraryForm.hidden = true;
});
createLibraryForm.addEventListener('submit', async event => {
  event.preventDefault();
  const title = document.querySelector('#libraryName').value.trim();
  if (!title) return;
  const existing = collections.find(item => item.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase());
  if (existing) {
    select.value = existing.id;
    await chrome.storage.local.set({ selectedCollectionId: existing.id });
    status.textContent = `Библиотека «${existing.title}» уже есть — выбрал её.`;
    createLibraryForm.hidden = true; createLibraryForm.reset();
    return;
  }
  const created = { id: crypto.randomUUID(), title, items: [] };
  collections.push(created);
  await chrome.storage.local.set({ collections, selectedCollectionId: created.id });
  renderLibrarySelect(created.id);
  createLibraryForm.reset(); createLibraryForm.hidden = true;
  status.textContent = `Создана библиотека «${created.title}». Страницы будут добавляться сюда.`;
});
document.querySelector('#deleteAllLibraries').addEventListener('click', async () => {
  const pageCount = collections.reduce((sum, library) => sum + library.items.filter(item => item.kind !== 'section').length, 0);
  if (!confirm(`Удалить все ${collections.length} библиотек и ${pageCount} сохранённых страниц? Это действие нельзя отменить.`)) return;
  collections = [];
  await chrome.storage.local.set({ collections: [], selectedCollectionId: '' });
  renderLibrarySelect('');
  preview.hidden = true; addSelected.hidden = true;
  status.textContent = 'Все библиотеки удалены. Создайте новую, чтобы продолжить.';
});

function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

function hierarchyKey(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\.(html?|php|aspx?)$/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function routeFolderNames(value) {
  try {
    const parts = decodeURIComponent(new URL(value).pathname).split('/').filter(Boolean);
    if (parts.length && /\.(html?|php|aspx?)$/i.test(parts.at(-1))) parts.pop();
    return parts.filter((part, index) => !(index === 0 && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(part)) && !/^(docs?|documentation)$/i.test(part))
      .map(part => part.replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_]+/g, ' ').replace(/\bpbx\b/gi, 'PBX').replace(/\bapi\b/gi, 'API').replace(/\bivr\b/gi, 'IVR').replace(/\bssl\b/gi, 'SSL').replace(/\b\w/g, c => c.toUpperCase()))
      .filter(Boolean);
  } catch { return []; }
}

function inferHierarchy(data) {
  const pageUrl=normalizeUrl(data.url), siteName=hierarchyKey(data.siteTitle);
  const cleanSignal = signal => (signal || []).filter(x => x?.title && x.title.toLowerCase() !== 'home' && hierarchyKey(x.title) !== siteName && (!x.url || normalizeUrl(x.url)!==pageUrl))
    .filter((x,i,a)=>i===0||hierarchyKey(x.title)!==hierarchyKey(a[i-1].title));
  const breadcrumbs=cleanSignal(data.breadcrumbs), navPath=cleanSignal(data.navPath);
  let chosen = breadcrumbs.length >= navPath.length ? breadcrumbs : navPath;
  let path = chosen.map(x => ({title:x.title,url:x.url||''}));
  const route = routeFolderNames(data.url);
  if (!path.length) path = route.map(title => ({title,url:''}));
  else {
    // A version segment is useful context even when a site menu omits it.
    const versions = route.filter(name => /^(?:v)?\d+(?:\.\d+)*(?:\.x)?$|^(?:latest|stable|main)$/i.test(name));
    for (const version of versions) if (!path.some(item => hierarchyKey(item.title) === hierarchyKey(version))) path.unshift({title:version,url:''});
  }
  const result=[];
  for(const item of path) if(item.title && (!result.length || hierarchyKey(result[result.length-1].title)!==hierarchyKey(item.title))) result.push(item);
  return result;
}

function placeByBreadcrumbs(collection, data) {
  const crumbs = inferHierarchy(data);
  let parentId = null;
  for (const crumb of crumbs) {
    const key=hierarchyKey(crumb.title);
    let section = collection.items.find(item => item.kind === 'section' && hierarchyKey(item.title) === key && item.parentId === parentId);
    if (!section) {
      section = { id: crypto.randomUUID(), kind: 'section', parentId, title: crumb.title, url: crumb.url || '', addedAt: Date.now() };
      collection.items.push(section);
    }
    parentId = section.id;
  }
  return parentId;
}

function saveToCollection(collection, data, updateDuplicate = null) {
  const canonical = normalizeUrl(data.url);
  const duplicate = collection.items.find(item => item.kind !== 'section' && normalizeUrl(item.url) === canonical);
  if (duplicate) {
    const shouldUpdate = updateDuplicate === null ? confirm(`Эта страница уже есть в коллекции:\n${duplicate.title}\n\nОбновить сохранённую копию?`) : updateDuplicate;
    if (!shouldUpdate) return 'skipped';
    const { id, parentId, addedAt, ...rest } = data;
    Object.assign(duplicate, rest, { hierarchyPath: inferHierarchy(data).map(x=>x.title), updatedAt: Date.now() });
    return 'updated';
  }
  const hierarchyPath=inferHierarchy(data).map(x=>x.title);
  const parentId = placeByBreadcrumbs(collection, data);
  collection.items.push({ ...data, hierarchyPath, id: crypto.randomUUID(), parentId, addedAt: Date.now() });
  return 'added';
}

async function captureCurrent(tabId) {
  const [page] = await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
    const root = document.querySelector('main, article, [role="main"]') || document.body;
    const copy = root.cloneNode(true);
    copy.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,button,[role="navigation"],.advertisement,.ads').forEach(n => n.remove());
    const usedIds = new Set([...copy.querySelectorAll('[id]')].map(node => node.id));
    const headings = [...copy.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((heading, index) => {
      if (!heading.id) { const base=`sitedoc-heading-${index+1}`; let id=base, suffix=1; while(usedIds.has(id)) id=`${base}-${++suffix}`; heading.id=id; usedIds.add(id); }
      return { id: heading.id, title: (heading.innerText || heading.textContent || '').trim(), level: Number(heading.tagName.slice(1)) };
    }).filter(x => x.title);
    const breadcrumbs = (() => {
      const nav = document.querySelector('[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, nav[aria-label*="path" i]');
      if (!nav) return [];
      return [...nav.querySelectorAll('a,[aria-current="page"]')].map(node => ({ title: (node.innerText || node.textContent || '').trim(), url: node.href || '' })).filter(x => x.title);
    })();
    const navPath = (() => {
      const canonical=value=>{try{const url=new URL(value,location.href);url.hash='';return url.href.replace(/\/$/,'');}catch{return '';}};
      const current=canonical(location.href), matches=[...document.querySelectorAll('a[href]')].filter(a=>canonical(a.href)===current);
      let best=[];
      for(const anchor of matches){
        const li=anchor.closest('li');if(!li)continue;
        const path=[];let node=li.parentElement?.closest('li');
        while(node){
          const label=node.querySelector(':scope > a, :scope > label, :scope > span, :scope > div > a, :scope > div > span');
          const title=(label?.innerText||label?.textContent||'').trim().replace(/\s+/g,' ');
          if(title&&title.length<120)path.unshift({title,url:label.href||''});
          node=node.parentElement?.closest('li');
        }
        if(path.length>best.length)best=path;
      }
      return best;
    })();
    let embeddedBytes = 0;
    const toDataUrl = async source => {
      const response = await fetch(source, { credentials: 'include' }); if (!response.ok) return null;
      const blob = await response.blob(); if (embeddedBytes + blob.size > 2_000_000) return null; embeddedBytes += blob.size;
      return await new Promise(resolve => { const reader=new FileReader(); reader.onload=()=>resolve(reader.result); reader.onerror=()=>resolve(null); reader.readAsDataURL(blob); });
    };
    await Promise.all([...copy.querySelectorAll('img')].map(async image => {
      const raw=image.currentSrc || image.getAttribute('src') || image.getAttribute('data-src'); if(!raw)return;
      const source=new URL(raw,location.href).href; image.setAttribute('src',source); image.removeAttribute('srcset');
      try { const data=await toDataUrl(source); if(data)image.setAttribute('src',data); } catch {}
    }));
    const styles=[];
    for(const sheet of document.styleSheets){
      try {
        let css=[...sheet.cssRules].map(rule=>rule.cssText).join('\n');
        const urls=[...new Set([...css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)].map(m=>m[1]).filter(u=>!u.startsWith('data:')&&!u.startsWith('#')))];
        for(const source of urls){try{const absolute=new URL(source,sheet.href||location.href).href;const data=await toDataUrl(absolute);css=css.split(source).join(data||absolute);}catch{}}
        styles.push({href:sheet.href||location.href,css});
      } catch { if(sheet.href)styles.push({href:sheet.href,css:`@import url("${sheet.href.replaceAll('"','%22')}");`}); }
    }
    return {title:document.title,url:location.href,html:copy.innerHTML,text:copy.innerText||copy.textContent||'',headings,breadcrumbs,navPath,styles,siteTitle:document.querySelector('meta[property="og:site_name"]')?.content||location.hostname};
  }});
  return page.result;
}

async function saveCurrent() {
  status.textContent = 'Сохраняю страницу…';
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    const data = await captureCurrent(tab.id);
    const {collections=[]} = await read(['collections']);
    const collection=collections.find(c=>c.id===select.value); if(!collection)throw new Error('Коллекция не найдена');
    const result=saveToCollection(collection,data);
    if(result==='skipped'){status.textContent='Оставил сохранённую копию без изменений.';return;}
    await chrome.storage.local.set({collections});
    status.textContent = result==='updated' ? `Обновлено: ${data.title}` : `Добавлено: ${data.title}`;
  } catch(e) { status.textContent=`Не удалось сохранить страницу: ${e.message}`; }
}

async function findSectionLinks() {
  status.textContent='Ищу соседние страницы в меню документации…';
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const [injection]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
      const here=new URL(location.href), canonical=value=>{const u=new URL(value,location.href);u.hash='';if(u.pathname.length>1)u.pathname=u.pathname.replace(/\/+$/,'');return u.href;};
      const current=canonical(location.href), candidates=new Map();
      const titleOf=a=>(a.innerText||a.getAttribute('aria-label')||a.title||'').trim().replace(/\s+/g,' ');
      const valid=(a)=>{try{const u=new URL(a.href);return u.origin===here.origin&&!/\.(pdf|png|jpe?g|svg|zip|tar|gz|css|js)$/i.test(u.pathname);}catch{return false;}};
      const currentLinks=[...document.querySelectorAll('a[href]')].filter(a=>valid(a)&&canonical(a.href)===current);
      const crumbNav=document.querySelector('[aria-label*="breadcrumb" i],.breadcrumb,.breadcrumbs');
      let pageCrumbs=crumbNav?[...crumbNav.querySelectorAll('a,[aria-current="page"]')].map(a=>({title:titleOf(a),url:a.href})).filter(x=>x.title):[];
      let best=null;
      for(const anchor of currentLinks){
        const li=anchor.closest('li'); if(!li)continue;
        const list=li.parentElement; if(!list||!['UL','OL'].includes(list.tagName))continue;
        const siblings=[...list.children].filter(child=>child.tagName==='LI').map(item=>{
          const links=[...item.querySelectorAll('a[href]')].filter(a=>a.closest('ul,ol')===list);
          return links[0]?{item,link:links[0]}:null;
        }).filter(Boolean).filter(x=>valid(x.link)&&canonical(x.link.href)!==current);
        const active=anchor.matches('[aria-current="page"],.md-nav__link--active,.active,.current');
        const primary=!!anchor.closest('.md-nav--primary,.md-sidebar--primary,.wy-nav-side,.wy-menu,[role="tree"]');
        const score=(active?100:0)+(primary?60:0)+(anchor.closest('.md-nav__list')?30:0)+Math.min(siblings.length,30);
        if(siblings.length&&score>(best?.score??-1)){
          const ancestors=[];let node=li.parentElement?.closest('li');
          while(node){
            const label=node.querySelector(':scope > a, :scope > label, :scope > span, :scope > div > a, :scope > div > span');
            const text=(label?.innerText||label?.textContent||'').trim().replace(/\s+/g,' ');
            if(text&&text.length<120)ancestors.unshift({title:text,url:label.href||''});
            node=node.parentElement?.closest('li');
          }
          best={links:siblings,crumbs:ancestors,score};
        }
      }
      const chosen=best?.links||[];
      for(const {link} of chosen){
        const url=canonical(link.href),title=titleOf(link);if(title.length>1)candidates.set(url,{url,title,breadcrumbs:best?.crumbs?.length?best.crumbs:pageCrumbs});
      }
      // Fallback for sites without an explicit list-based navigation: use sibling URLs
      // from the current path directory, but keep this lower priority than the nav tree.
      if(!candidates.size){
        const directory=here.pathname.slice(0,here.pathname.lastIndexOf('/')+1);
        for(const a of document.querySelectorAll('a[href]')){
          if(!valid(a))continue;const url=canonical(a.href),u=new URL(url);
          if(url===current||!u.pathname.startsWith(directory))continue;
          const title=titleOf(a);if(title.length>1&&!candidates.has(url))candidates.set(url,{url,title,breadcrumbs:pageCrumbs});
        }
      }
      const siblingCount=candidates.size;
      if(!candidates.has(current))candidates.set(current,{url:current,title:document.title||titleOf(currentLinks[0])||here.pathname.split('/').filter(Boolean).pop()||here.hostname,breadcrumbs:best?.crumbs?.length?best.crumbs:pageCrumbs});
      return {items:[...candidates.values()],siblingCount};
    }});
    const result=injection?.result?.items||[];
    if(!result.length){status.textContent='На этой странице не удалось прочитать текущий адрес.';return;}
    candidatePages=new Map(result.map(item=>[item.url,item]));
    const context=result.find(item=>item.breadcrumbs?.length)?.breadcrumbs.map(x=>x.title).filter(Boolean).join(' › ')||'Группа страниц из меню сайта';
    document.querySelector('#sectionContext').textContent=context;
    document.querySelector('#resultCount').textContent=result.length;
    sectionList.innerHTML=result.map(item=>{
      const isCurrent=normalizeUrl(item.url)===normalizeUrl(tab.url);
      const path=new URL(item.url).pathname;
      return `<label class="section-link ${isCurrent?'is-current':''}"><input type="checkbox" value="${esc(item.url)}" checked><span class="section-copy"><span class="section-title">${esc(item.title)}</span><small>${esc(path)}</small></span>${isCurrent?'<span class="current-badge">Открыта</span>':''}</label>`;
    }).join('');
    selectAll.checked=true;selectAll.indeterminate=false;updateSelectionCount();
    preview.hidden=false; addSelected.hidden=false;
    status.textContent=injection.result.siblingCount===0?'Соседние страницы не найдены; текущую страницу всё равно можно добавить.':'Отметьте страницы, которые хотите сохранить. Текущая страница тоже включена.';
  }catch(e){status.textContent=`Не удалось прочитать раздел: ${e.message}`;}
}

async function fetchSelectedPages() {
    const urls=[...sectionList.querySelectorAll('input:checked')].map(input=>input.value);
  if(!urls.length){status.textContent='Выберите хотя бы одну страницу.';return;}
  status.textContent=`Добавляю ${urls.length} страниц…`;
  addSelected.disabled=true;
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const descriptors=[...sectionList.querySelectorAll('input:checked')].map(input=>({url:input.value,...(candidatePages.get(input.value)||{})}));
    const {collections=[]}=await read(['collections']);
    const collection=collections.find(c=>c.id===select.value);if(!collection)throw new Error('Выбранная библиотека больше не существует.');
    const canonical=url=>{try{const u=new URL(url);u.hash='';if(u.pathname.length>1)u.pathname=u.pathname.replace(/\/+$/,'');return u.href;}catch{return url;}};
    const existingUrls=new Set(collection.items.filter(item=>item.kind!=='section').map(item=>canonical(item.url)));
    const duplicateCount=descriptors.filter(item=>existingUrls.has(canonical(item.url))).length;
    const updateExisting=duplicateCount?confirm(`В библиотеке уже сохранено страниц из списка: ${duplicateCount}. Обновить эти копии?`):false;
    let added=0,updated=0,failed=0;
    const batchSize=5;
    for(let offset=0;offset<descriptors.length;offset+=batchSize){
      const batch=descriptors.slice(offset,offset+batchSize);
      const end=Math.min(offset+batch.length,descriptors.length);
      status.textContent=`Загружаю страницы ${offset+1}–${end} из ${descriptors.length}…`;
      try{
        const [injection]=await chrome.scripting.executeScript({target:{tabId:tab.id},args:[batch],func:async descriptors=>{
      const output=[];
      for(const descriptor of descriptors){
        const {url}=descriptor;
        try{
          const response=await fetch(url,{credentials:'include'}); if(!response.ok)throw new Error(`HTTP ${response.status}`);
          const source=await response.text(), doc=new DOMParser().parseFromString(source,'text/html');
          const root=doc.querySelector('main,article,[role="main"]')||doc.body;
          const copy=root.cloneNode(true); copy.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,button,[role="navigation"]').forEach(n=>n.remove());
          let assetBytes=0;
          const dataUrl=async source=>{
            try{
              const response=await fetch(source,{credentials:'include'});if(!response.ok)return null;
              const blob=await response.blob();if(assetBytes+blob.size>2_000_000)return null;assetBytes+=blob.size;
              return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>resolve(null);reader.readAsDataURL(blob);});
            }catch{return null;}
          };
          await Promise.all([...copy.querySelectorAll('img')].map(async image=>{
            const raw=image.getAttribute('src')||image.getAttribute('data-src')||image.getAttribute('data-original');if(!raw)return;
            const absolute=new URL(raw,url).href;image.setAttribute('src',absolute);image.removeAttribute('srcset');
            const embedded=await dataUrl(absolute);if(embedded)image.setAttribute('src',embedded);
          }));
          const headings=[...copy.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h,i)=>{if(!h.id)h.id=`sitedoc-heading-${i+1}`;return{id:h.id,title:(h.textContent||'').trim(),level:Number(h.tagName.slice(1))};}).filter(h=>h.title);
          const crumbs=doc.querySelector('[aria-label*="breadcrumb" i],.breadcrumb,.breadcrumbs');
          const breadcrumbs=crumbs?[...crumbs.querySelectorAll('a,[aria-current="page"]')].map(a=>({title:(a.textContent||'').trim(),url:a.href})).filter(x=>x.title):[];
          const title=doc.title||(headings[0]?.title)||url;
          const styleLinks=[...doc.querySelectorAll('link[rel="stylesheet"][href]')].slice(0,10);
          const styles=[...doc.querySelectorAll('style')].map(style=>({href:url,css:style.textContent||''}));
          for(const link of styleLinks){
            const href=new URL(link.getAttribute('href'),url).href;
            try{
              const response=await fetch(href,{credentials:'include'});if(!response.ok)throw new Error('stylesheet fetch failed');
              let css=(await response.text()).slice(0,300_000);
              const resources=[...new Set([...css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)].map(m=>m[1]).filter(src=>!src.startsWith('data:')&&!src.startsWith('#')))];
              for(const src of resources){const absolute=new URL(src,href).href;const embedded=await dataUrl(absolute);css=css.split(src).join(embedded||absolute);}
              styles.push({href,css});
            }catch{styles.push({href,css:`@import url("${href.replaceAll('"','%22')}");`});}
          }
          output.push({title,url,html:copy.innerHTML,text:copy.innerText||copy.textContent||'',headings,breadcrumbs,navPath:descriptor.breadcrumbs||[],styles,siteTitle:doc.querySelector('meta[property="og:site_name"]')?.content||new URL(url).hostname});
        }catch(error){output.push({url,error:error.message});}
      }
      return output;
        }});
        const pages=injection?.result||[];
        for(const page of pages){
          if(page.error){failed++;continue;}
          const outcome=saveToCollection(collection,page,updateExisting);
          if(outcome==='added')added++;else if(outcome==='updated')updated++;
        }
        failed+=Math.max(0,batch.length-pages.length);
        await chrome.storage.local.set({collections});
      }catch(error){failed+=batch.length;status.textContent=`Партия ${offset+1}–${end} не загрузилась: ${error.message}`;}
    }
    preview.hidden=true;addSelected.hidden=true;
    status.textContent=`Готово: добавлено ${added}, обновлено ${updated}${failed?`, ошибок ${failed}`:''}.`;
  }catch(e){status.textContent=`Ошибка сбора раздела: ${e.message}`;}
  finally{addSelected.disabled=false;}
}

document.querySelector('#save').addEventListener('click',saveCurrent);
document.querySelector('#findSection').addEventListener('click',findSectionLinks);
addSelected.addEventListener('click',fetchSelectedPages);
function updateSelectionCount(){
  const boxes=[...sectionList.querySelectorAll('input[type=checkbox]')],checked=boxes.filter(x=>x.checked).length;
  selectedCount.textContent=`${checked} из ${boxes.length}`;
  selectAll.checked=checked===boxes.length;selectAll.indeterminate=checked>0&&checked<boxes.length;
  addSelected.textContent=checked?`Добавить выбранные (${checked})`:'Выберите страницы';
  addSelected.disabled=checked===0;
}
sectionList.addEventListener('change',updateSelectionCount);
selectAll.addEventListener('change',e=>{sectionList.querySelectorAll('input[type=checkbox]').forEach(x=>x.checked=e.target.checked);updateSelectionCount();});
init();
