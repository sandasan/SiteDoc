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
let activeJobState=null;
const read = keys => chrome.storage.local.get(keys);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function init() {
  const saved = await read(['collections', 'selectedCollectionId','sectionCandidates','activeJob']);
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
  if(saved.sectionCandidates?.length){
    candidatePages=new Map(saved.sectionCandidates.map(item=>[item.url,item]));
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    renderCandidates(saved.sectionCandidates,tab?.url||'');
  }
  showJob(saved.activeJob);
}

function renderCandidates(items,currentUrl=''){
  candidatePages=new Map(items.map(item=>[item.url,item]));
  const context=items.find(item=>item.breadcrumbs?.length)?.breadcrumbs.map(x=>x.title).filter(Boolean).join(' › ')||'Все разделы и подразделы, найденные в меню сайта';
  document.querySelector('#sectionContext').textContent=context;
  document.querySelector('#resultCount').textContent=items.length;
  sectionList.innerHTML=items.map(item=>{
    const isCurrent=currentUrl&&normalizeUrl(item.url)===normalizeUrl(currentUrl),path=new URL(item.url).pathname,depth=Math.min(8,Math.max(0,Number(item.depth)||0));
    return `<label class="section-link ${isCurrent?'is-current':''} ${depth?'is-descendant':''}" style="--depth:${depth}"><input type="checkbox" value="${esc(item.url)}" checked><span class="section-copy"><span class="section-title">${esc(item.title)}</span><small>${esc(path)}</small></span>${isCurrent?'<span class="current-badge">Открыта</span>':''}</label>`;
  }).join('');
  selectAll.checked=true;selectAll.indeterminate=false;updateSelectionCount();preview.hidden=false;addSelected.hidden=false;
}

function showJob(job){
  if(!job)return;
  activeJobState=job;
  if(job.phase==='running'||job.phase==='starting'){
    status.textContent=job.type==='scan'?'Сканирую все разделы и подразделы в фоне. Popup можно закрыть; результат появится здесь после повторного открытия.':`Сохраняю страницы в фоне: ${job.done||0} из ${job.total||0}. Popup можно закрыть.`;
  }else if(job.phase==='complete'){
    if(job.type==='scan'){
      const message=job.stopReason?`Сканирование остановлено ответом сервера (${job.stopReason}).`:`Сканирование завершено: проверено ${job.done} страниц.`;
      status.textContent=`${message} Отметьте страницы и нажмите «Добавить выбранные».`;
    }else status.textContent=`Сохранение завершено: добавлено ${job.added}, обновлено ${job.updated}${job.failed?`, ошибок ${job.failed}`:''}${job.stopReason?`. Остановлено по ответу сервера (${job.stopReason}).`:'.'}`;
  }else if(job.phase==='error')status.textContent=`Фоновая операция завершилась с ошибкой: ${job.error||'неизвестная ошибка'}`;
  renderAddButton();
}

function renderAddButton(){
  const checked=sectionList.querySelectorAll('input[type=checkbox]:checked').length;
  const job=activeJobState;
  addSelected.classList.remove('is-progress','is-complete','is-stopped','is-scan');
  addSelected.style.setProperty('--progress','0%');
  if(job?.type==='import'&&(job.phase==='running'||job.phase==='starting')){
    const total=Math.max(1,Number(job.total)||checked),done=Math.min(total,Number(job.done)||0),percent=Math.round(done/total*100);
    addSelected.classList.add('is-progress');addSelected.style.setProperty('--progress',`${percent}%`);
    addSelected.textContent=`Сохранение страниц: ${done} из ${total}`;addSelected.disabled=true;return;
  }
  if(job?.type==='import'&&job.phase==='complete'){
    const total=Math.max(1,Number(job.total)||checked),done=Math.min(total,Number(job.done)||0),percent=Math.round(done/total*100);
    addSelected.classList.add(job.stopReason?'is-stopped':'is-complete');addSelected.style.setProperty('--progress',`${percent}%`);
    addSelected.textContent=job.stopReason?`Остановлено: ${done} из ${total}`:job.failed?`Завершено с ошибками: ${done} из ${total}`:`Добавление завершено: ${done} из ${total}`;
    addSelected.disabled=true;return;
  }
  if(job?.type==='import'&&job.phase==='error'){
    const total=Math.max(1,Number(job.total)||checked),done=Math.min(total,Number(job.done)||0),percent=Math.round(done/total*100);
    addSelected.classList.add('is-stopped');addSelected.style.setProperty('--progress',`${percent}%`);
    addSelected.textContent=`Прервано: ${done} из ${total} · выполните новый поиск`;addSelected.disabled=true;return;
  }
  if(job?.type==='scan'&&(job.phase==='running'||job.phase==='starting')){
    addSelected.classList.add('is-scan');addSelected.textContent='Поиск всех страниц…';addSelected.disabled=true;return;
  }
  addSelected.textContent=checked?`Добавить выбранные (${checked})`:'Выберите страницы';
  addSelected.disabled=checked===0;
}

chrome.storage.onChanged.addListener(async(changes,area)=>{
  if(area!=='local')return;
  if(changes.sectionCandidates?.newValue){
    candidatePages=new Map(changes.sectionCandidates.newValue.map(item=>[item.url,item]));
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    renderCandidates(changes.sectionCandidates.newValue,tab?.url||'');
  }
  if(changes.activeJob)showJob(changes.activeJob.newValue);
});

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

function findOrCreateSection(collection, title, parentId, url = '') {
  const key=hierarchyKey(title);
  let section=collection.items.find(item=>item.kind==='section'&&hierarchyKey(item.title)===key&&item.parentId===parentId);
  if(!section){section={id:crypto.randomUUID(),kind:'section',parentId,title,url,addedAt:Date.now()};collection.items.push(section);}
  return section;
}

function placeByBreadcrumbs(collection, data) {
  const crumbs = inferHierarchy(data);
  let parentId = null;
  for (const crumb of crumbs) {
    const section=findOrCreateSection(collection,crumb.title,parentId,crumb.url||'');
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
  let parentId = null;
  if(data.parentUrl){
    const parentUrl=normalizeUrl(data.parentUrl);
    const parentPage=collection.items.find(item=>item.kind!=='section'&&normalizeUrl(item.url)===parentUrl);
    if(parentPage){
      parentId=parentPage.id;
      for(const sectionTitle of data.parentSections||[])parentId=findOrCreateSection(collection,sectionTitle,parentId).id;
    }
  }
  if(!parentId)parentId=placeByBreadcrumbs(collection,data);
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
    const menuHierarchy = (() => {
      const canonical=value=>{try{const url=new URL(value,location.href);url.hash='';return url.href.replace(/\/$/,'');}catch{return '';}};
      const valid=a=>{try{const raw=a.getAttribute('href')||'';const url=new URL(a.href);return !raw.trim().startsWith('#')&&url.origin===location.origin;}catch{return false;}};
      const current=canonical(location.href), matches=[...document.querySelectorAll('a[href]')].filter(a=>canonical(a.href)===current);
      let best={path:[],parentUrl:null,parentTitle:'',parentSections:[]};
      for(const anchor of matches){
        const li=anchor.closest('li');if(!li)continue;
        const path=[],pendingSections=[];let parentUrl=null,parentTitle='',parentSections=[];let node=li.parentElement?.closest('li');
        while(node){
          const label=node.querySelector(':scope > a, :scope > label, :scope > span, :scope > div > a, :scope > div > span');
          const title=(label?.innerText||label?.textContent||'').trim().replace(/\s+/g,' ');
          if(title&&title.length<120)path.unshift({title,url:label.href||''});
          if(!parentUrl&&label?.tagName==='A'&&valid(label)&&canonical(label.href)!==current){parentUrl=canonical(label.href);parentTitle=title;parentSections=pendingSections.slice().reverse();}
          else if(!parentUrl&&title)pendingSections.push(title);
          node=node.parentElement?.closest('li');
        }
        if(path.length>best.path.length)best={path,parentUrl,parentTitle,parentSections};
      }
      return best;
    })();
    const dataUrlCache = new Map();
    const toDataUrl = source => {
      if(dataUrlCache.has(source))return dataUrlCache.get(source);
      const request=(async()=>{try {
        const response = await fetch(source, { credentials: 'include' });
        if (!response.ok) return null;
        const blob = await response.blob();
        return await new Promise(resolve => { const reader=new FileReader(); reader.onload=()=>resolve(reader.result); reader.onerror=()=>resolve(null); reader.readAsDataURL(blob); });
      } catch { return null; }})();
      dataUrlCache.set(source,request);
      return request;
    };
    // Process every image in small batches to keep peak network and memory pressure low.
    const images = [...copy.querySelectorAll('img')];
    for (let start = 0; start < images.length; start += 3) await Promise.all(images.slice(start, start + 3).map(async image => {
      const srcset=image.getAttribute('data-srcset')||image.getAttribute('srcset')||image.parentElement?.querySelector('source[srcset]')?.getAttribute('srcset')||'';
      const largest=srcset.split(',').map(candidate=>candidate.trim().split(/\s+/)).filter(candidate=>candidate[0]).sort((a,b)=>parseFloat(b[1]) - parseFloat(a[1]))[0]?.[0];
      const raw=image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('data-lazy-src') || image.currentSrc || largest || image.getAttribute('src'); if(!raw)return;
      const source=new URL(raw,location.href).href; image.setAttribute('src',source); image.removeAttribute('srcset');
      image.removeAttribute('loading');
      const data=await toDataUrl(source); if(data){image.setAttribute('src',data);if(image.parentElement?.tagName==='PICTURE')image.parentElement.querySelectorAll('source').forEach(node=>node.removeAttribute('srcset'));}
    }));
    const styles=[];
    for(const sheet of [...document.styleSheets]){
      try {
        const rules=[];
        for(let i=0;i<sheet.cssRules.length;i+=200){rules.push(...[...sheet.cssRules].slice(i,i+200).map(rule=>rule.cssText));await new Promise(resolve=>setTimeout(resolve,0));}
        let css=rules.join('\n');
        const urls=[...new Set([...css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)].map(m=>m[1].trim()).filter(u=>!u.startsWith('data:')&&!u.startsWith('#')))];
        for(const source of urls){try{const absolute=new URL(source,sheet.href||location.href).href;const data=await toDataUrl(absolute);css=css.split(source).join(data||absolute);}catch{}}
        styles.push({href:sheet.href||location.href,css});
      } catch {
        // Cross-origin stylesheets hide cssRules; fetch their text directly when CORS permits.
        if(sheet.href)try{
          const response=await fetch(sheet.href,{credentials:'include'});
          if(response.ok){let css=await response.text();const urls=[...new Set([...css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)].map(m=>m[1].trim()).filter(u=>!u.startsWith('data:')&&!u.startsWith('#')))];for(const source of urls){try{const absolute=new URL(source,sheet.href).href;const data=await toDataUrl(absolute);css=css.split(source).join(data||absolute);}catch{}}styles.push({href:sheet.href,css});}
        }catch{}
      }
    }
    // Inline background images are common in documentation cards and diagrams.
    const styledNodes=[...copy.querySelectorAll('[style*="url("]')];
    for(const node of styledNodes){
      let inline=node.getAttribute('style')||'';
      const urls=[...new Set([...inline.matchAll(/url\(["']?([^"')]+)["']?\)/gi)].map(m=>m[1].trim()).filter(u=>!u.startsWith('data:')&&!u.startsWith('#')))];
      for(const source of urls){const absolute=new URL(source,location.href).href;const data=await toDataUrl(absolute);if(data)inline=inline.split(source).join(data);}
      node.setAttribute('style',inline);
    }
    return {title:document.title,url:location.href,html:copy.innerHTML,text:copy.innerText||copy.textContent||'',headings,breadcrumbs,navPath:menuHierarchy.path,parentUrl:menuHierarchy.parentUrl,parentTitle:menuHierarchy.parentTitle,parentSections:menuHierarchy.parentSections,styles,siteTitle:document.querySelector('meta[property="og:site_name"]')?.content||location.hostname};
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
  status.textContent='Ищу все разделы в меню документации…';
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const [injection]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
      const here=new URL(location.href),canonical=value=>{try{const u=new URL(value,location.href);u.hash='';if(u.pathname.length>1)u.pathname=u.pathname.replace(/\/+$/,'');return u.href;}catch{return '';}},current=canonical(location.href);
      const titleOf=node=>(node?.innerText||node?.textContent||node?.getAttribute?.('aria-label')||node?.title||'').trim().replace(/\s+/g,' ');
      const valid=a=>{try{const raw=a.getAttribute('href')||'',u=new URL(a.href);return !raw.trim().startsWith('#')&&u.origin===here.origin&&!/\.(pdf|png|jpe?g|svg|zip|tar|gz|css|js)$/i.test(u.pathname);}catch{return false;}};
      const candidates=new Map(),navRoots=[...document.querySelectorAll('nav, [role="navigation"], .md-nav, .wy-nav-side, .toctree-wrapper, .sidebar')];
      const roots=navRoots.length?navRoots:[document.body];
      const lists=[...new Set(roots.flatMap(root=>[...root.querySelectorAll('ul,ol')]))].filter(list=>!list.parentElement?.closest('ul,ol'));
      const walk=(list,pageAncestors=[],sectionAncestors=[],depth=0)=>{
        for(const li of [...list.children].filter(node=>node.tagName==='LI')){
          const link=[...li.children].flatMap(node=>node.matches?.('a[href]')?[node]:[...node.querySelectorAll?.(':scope > a[href]')||[]]).find(valid);
          let nextPages=pageAncestors,nextSections=sectionAncestors,nextDepth=depth;
          if(link){
            const url=canonical(link.href),title=titleOf(link);
            if(title&&url){
              const parent=pageAncestors.at(-1)||null, parentSections=sectionAncestors;
              const navPath=[...pageAncestors.map(x=>({title:x.title,url:x.url})),...sectionAncestors.map(title=>({title,url:''}))];
              if(url!==current)candidates.set(url,{url,title,breadcrumbs:[],navPath,parentUrl:parent?.url||null,parentTitle:parent?.title||'',parentSections,depth});
              nextPages=[...pageAncestors,{title,url}];nextSections=[];nextDepth=depth+1;
            }
          }else{
            const label=[...li.children].find(node=>!['UL','OL'].includes(node.tagName));const title=titleOf(label);
            if(title&&title.length<120){nextSections=[...sectionAncestors,title];nextDepth=depth+1;}
          }
          for(const nested of [...li.children].filter(node=>['UL','OL'].includes(node.tagName)))walk(nested,nextPages,nextSections,nextDepth);
        }
      };
      for(const list of lists)walk(list);
      const title=document.querySelector('h1')?.innerText?.trim()||document.title||here.hostname;
      if(!candidates.has(current))candidates.set(current,{url:current,title,breadcrumbs:[],navPath:[],parentUrl:null,parentTitle:'',parentSections:[],depth:0});
      return {items:[...candidates.values()]};
    }});
    const result=injection?.result?.items||[];
    if(!result.length){status.textContent='На этой странице не удалось прочитать меню разделов.';return;}
    status.textContent=`Найдено ${result.length} страниц. Проверяю всё дерево в фоне…`;
    await chrome.storage.local.set({sectionCandidates:result,activeJob:{type:'scan',phase:'starting',tabId:tab.id,done:0,total:result.length,startedAt:Date.now()}});
    chrome.runtime.sendMessage({type:'START_SECTION_SCAN',tabId:tab.id,items:result,selectedUrl:tab.url}).catch(error=>{activeJobState={type:'scan',phase:'error'};renderAddButton();status.textContent=`Не удалось запустить фоновое сканирование: ${error.message}`;void chrome.storage.local.set({activeJob:{type:'scan',phase:'error',error:error.message}});});
    renderCandidates(result,tab.url);
    status.textContent='Обнаружение всего дерева выполняется в фоне. Popup можно закрыть; откройте его снова, чтобы увидеть результат.';
  }catch(e){status.textContent=`Не удалось прочитать разделы: ${e.message}`;}
}

async function fetchSelectedPages() {
  const urls=[...sectionList.querySelectorAll('input:checked')].map(input=>input.value);
  if(!urls.length){status.textContent='Выберите хотя бы одну страницу.';return;}
  addSelected.disabled=true;
  try{
    const savedJob=(await read(['activeJob'])).activeJob;
    let tab;
    try{tab=savedJob?.tabId?await chrome.tabs.get(savedJob.tabId):null;}catch{}
    if(!tab)[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const descriptors=[...sectionList.querySelectorAll('input:checked')].map(input=>({url:input.value,...(candidatePages.get(input.value)||{})}));
    const {collections=[]}=await read(['collections']);
    const collection=collections.find(c=>c.id===select.value);if(!collection)throw new Error('Выбранная библиотека больше не существует.');
    const canonical=url=>{try{const u=new URL(url);u.hash='';if(u.pathname.length>1)u.pathname=u.pathname.replace(/\/+$/,'');return u.href;}catch{return url;}};
    const existingUrls=new Set(collection.items.filter(item=>item.kind!=='section').map(item=>canonical(item.url)));
    const duplicateCount=descriptors.filter(item=>existingUrls.has(canonical(item.url))).length;
    const updateExisting=duplicateCount?confirm(`В библиотеке уже сохранено страниц из списка: ${duplicateCount}. Обновить эти копии?`):false;
    activeJobState={type:'import',phase:'starting',done:0,total:descriptors.length};renderAddButton();
    chrome.runtime.sendMessage({type:'START_SECTION_IMPORT',tabId:tab.id,items:descriptors,collectionId:collection.id,updateExisting}).catch(error=>{activeJobState={type:'import',phase:'error',done:0,total:descriptors.length};renderAddButton();status.textContent=`Не удалось запустить фоновое сохранение: ${error.message}`;void chrome.storage.local.set({activeJob:{type:'import',phase:'error',done:0,total:descriptors.length,error:error.message}});});
    status.textContent=`Сохранение ${descriptors.length} страниц выполняется в фоне. Popup можно закрыть.`;
  }catch(e){status.textContent=`Ошибка сбора раздела: ${e.message}`;addSelected.disabled=false;}
}

document.querySelector('#save').addEventListener('click',saveCurrent);
document.querySelector('#findSection').addEventListener('click',findSectionLinks);
addSelected.addEventListener('click',fetchSelectedPages);
function updateSelectionCount(){
  const boxes=[...sectionList.querySelectorAll('input[type=checkbox]')],checked=boxes.filter(x=>x.checked).length;
  selectedCount.textContent=`${checked} из ${boxes.length}`;
  selectAll.checked=checked===boxes.length;selectAll.indeterminate=checked>0&&checked<boxes.length;
  renderAddButton();
}
sectionList.addEventListener('change',updateSelectionCount);
selectAll.addEventListener('change',e=>{sectionList.querySelectorAll('input[type=checkbox]').forEach(x=>x.checked=e.target.checked);updateSelectionCount();});
init();
