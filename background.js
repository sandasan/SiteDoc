if(typeof importScripts==='function')importScripts('store.js');
const RESUME_ALARM='sitedoc-task-resume';
let scanRunning=false;
let importRunning=false;
const canonical=value=>{try{const u=new URL(value);u.hash='';if(u.pathname.length>1)u.pathname=u.pathname.replace(/\/+$/,'');return u.href;}catch{return String(value||'');}};

async function updateActionIndicator(job){
  if(job?.phase==='running'||job?.phase==='starting'){
    const total=Math.max(1,Number(job.total)||1),done=Math.max(0,Number(job.done)||0);
    const percent=Math.min(100,Math.floor(done/total*100));
    const label=job.type==='import'?'Сохранение страниц':'Поиск страниц';
    await chrome.action.setBadgeBackgroundColor({color:'#39785b'});
    await chrome.action.setBadgeText({text:`${percent}%`});
    await chrome.action.setTitle({title:`SiteDoc — ${label}: ${done} из ${total}`});
  }else{
    await chrome.action.setBadgeText({text:''});
    await chrome.action.setTitle({title:'Добавить страницу в SiteDoc'});
  }
}

chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&changes.activeJob)void updateActionIndicator(changes.activeJob.newValue);
});
chrome.runtime.onInstalled.addListener(()=>void chrome.storage.local.get('activeJob').then(({activeJob})=>updateActionIndicator(activeJob)));
void chrome.storage.local.get('activeJob').then(({activeJob})=>updateActionIndicator(activeJob));

chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message?.type==='START_SECTION_SCAN'){
    startScan(message).then(()=>sendResponse({started:true}),error=>sendResponse({error:error.message}));return true;
  }
  if(message?.type==='STOP_SECTION_SCAN'){
    stopScan().then(()=>sendResponse({stopping:true}),error=>sendResponse({error:error.message}));return true;
  }
  if(message?.type==='START_SECTION_IMPORT'){
    startImport({...message,tabId:message.tabId||sender.tab?.id}).then(()=>sendResponse({started:true}),error=>sendResponse({error:error.message}));return true;
  }
});

chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===RESUME_ALARM)void resumeTasks();});
chrome.runtime.onStartup.addListener(()=>void ensureResumeAlarm());

async function ensureResumeAlarm(){
  const saved=await chrome.storage.local.get(['scanProgress','importProgress']);
  if(saved.scanProgress||saved.importProgress)await chrome.alarms.create(RESUME_ALARM,{periodInMinutes:0.5});
}
async function scheduleResume(){await chrome.alarms.create(RESUME_ALARM,{periodInMinutes:0.5});}
async function clearResumeIfIdle(){
  const saved=await chrome.storage.local.get(['scanProgress','importProgress']);
  if(!saved.scanProgress&&!saved.importProgress)await chrome.alarms.clear(RESUME_ALARM);
}

async function startScan(message){
  const {activeJob}=await chrome.storage.local.get('activeJob');
  if(activeJob?.phase==='running'||activeJob?.phase==='stopping'||(activeJob?.phase==='starting'&&!(activeJob.type==='scan'&&activeJob.jobId===message.jobId)))throw new Error('Другая фоновая операция ещё выполняется.');
  if(message.jobId&&activeJob?.type==='scan'&&activeJob.jobId===message.jobId&&activeJob.phase==='complete')throw new Error('Сканирование было остановлено до запуска.');
  const state={jobId:message.jobId,tabId:message.tabId,selectedUrl:message.selectedUrl,scope:message.scope||'site',items:message.items,queue:[...message.items],visited:[],stopReason:''};
  const job={type:'scan',phase:'running',jobId:state.jobId,scope:state.scope,tabId:message.tabId,done:0,total:state.queue.length,startedAt:Date.now()};
  await chrome.storage.local.set({scanProgress:state,activeJob:job});
  await scheduleResume();
  void processScan();
}

async function stopScan(){
  const {scanProgress,activeJob}=await chrome.storage.local.get(['scanProgress','activeJob']);
  if(activeJob?.type!=='scan'||!['starting','running','stopping'].includes(activeJob.phase))throw new Error('Сканирование сейчас не выполняется.');
  if(scanProgress){
    await chrome.storage.local.set({scanProgress:{...scanProgress,cancelRequested:true},activeJob:{...activeJob,phase:'stopping'}});
    if(scanProgress.tabId)try{await chrome.scripting.executeScript({target:{tabId:scanProgress.tabId},func:()=>{const controller=globalThis.__sitedocScanAbort;if(controller){controller.__sitedocUserStop=true;controller.abort();}}});}catch{}
  }else await chrome.storage.local.set({activeJob:{...activeJob,phase:'complete',stopReason:'Остановлено пользователем',finishedAt:Date.now()}});
  void processScan();
}

async function processScan(){
  if(scanRunning)return;scanRunning=true;
  try{
    while(true){
      const saved=await chrome.storage.local.get(['scanProgress','activeJob']);
      const state=saved.scanProgress,job=saved.activeJob;
      if(!state||job?.type!=='scan')break;
      if(state.cancelRequested){
        await chrome.storage.local.set({sectionCandidates:state.items,activeJob:{...job,phase:'complete',done:state.visited.length,total:state.visited.length,stopReason:'Остановлено пользователем',finishedAt:Date.now()}});
        await chrome.storage.local.remove('scanProgress');break;
      }
      if(state.retryAt&&state.retryAt>Date.now()){await chrome.alarms.create(RESUME_ALARM,{when:state.retryAt});break;}
      if(!state.queue.length||state.stopReason){
        await chrome.storage.local.set({sectionCandidates:state.items,activeJob:{...job,phase:'complete',done:state.visited.length,total:state.visited.length,stopReason:state.stopReason||'',finishedAt:Date.now()}});
        await chrome.storage.local.remove('scanProgress');break;
      }
      const next=await scanChunk(state);
      const latest=await chrome.storage.local.get(['scanProgress','activeJob']);
      if(!latest.scanProgress||latest.activeJob?.type!=='scan')break;
      if(latest.scanProgress.cancelRequested){
        await chrome.storage.local.set({sectionCandidates:next.items,activeJob:{...latest.activeJob,phase:'complete',done:next.visited.length,total:next.visited.length,stopReason:'Остановлено пользователем',finishedAt:Date.now()}});
        await chrome.storage.local.remove('scanProgress');break;
      }
      await chrome.storage.local.set({scanProgress:next,activeJob:{...latest.activeJob,done:next.visited.length,total:Math.max(next.visited.length,next.items.length)}});
    }
  }catch(error){
    const {activeJob}=await chrome.storage.local.get('activeJob');
    if(activeJob?.type==='scan')await chrome.storage.local.set({activeJob:{...activeJob,phase:'error',error:error.message,finishedAt:Date.now()}});
    await chrome.storage.local.remove('scanProgress');
  }finally{scanRunning=false;await clearResumeIfIdle();}
}

async function scanChunk(state){
  const [injection]=await chrome.scripting.executeScript({target:{tabId:state.tabId},args:[state],func:async state=>{
    const canonical=value=>{try{const u=new URL(value,location.href);u.hash='';if(u.pathname.length>1)u.pathname=u.pathname.replace(/\/+$/,'');return u.href;}catch{return value;}};
    const items=new Map(state.items.map(item=>[canonical(item.url),{...item,url:canonical(item.url)}]));
    const queue=[...state.queue],visited=new Set(state.visited);let stopReason=state.stopReason||'',lastRequestAt=0;
    const scanController=new AbortController();
    globalThis.__sitedocScanAbort=scanController;
    const scanTimeout=setTimeout(()=>scanController.abort(),30_000);
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    // Keep requests gentle and let the stop button abort the active fetch.
    const politeFetch=async url=>{if(lastRequestAt)await pause(Math.max(0,1000-(Date.now()-lastRequestAt)));const response=await fetch(url,{credentials:'include',signal:scanController.signal});lastRequestAt=Date.now();return response;};
    const titleOf=a=>(a.textContent||a.getAttribute('aria-label')||a.title||'').trim().replace(/\s+/g,' ');
    for(let count=0;count<2&&queue.length&&!stopReason;count++){
      const parent=queue.shift(),key=canonical(parent.url);if(visited.has(key))continue;visited.add(key);
      try{
        const response=await politeFetch(key);
        if(response.status>=500||[408,425,429].includes(response.status)){
          const retryAfter=response.headers.get('Retry-After');
          const wait=retryAfter?( /^\d+$/.test(retryAfter)?Number(retryAfter)*1000:Math.max(0,Date.parse(retryAfter)-Date.now()) ):Math.min(60*60*1000,5*60*1000*2**Math.min(Number(state.retryCount)||0,4));
          queue.unshift(parent);visited.delete(key);
          clearTimeout(scanTimeout);
          if(globalThis.__sitedocScanAbort===scanController)delete globalThis.__sitedocScanAbort;
          return{...state,items:[...items.values()],queue,visited:[...visited],retryCount:(Number(state.retryCount)||0)+1,retryAt:Date.now()+Math.max(60*1000,wait),stopReason:''};
        }
        if([401,403].includes(response.status)){stopReason=`HTTP ${response.status}`;break;}
        if(!response.ok)continue;
        const doc=new DOMParser().parseFromString(await response.text(),'text/html');
        const documentUrl=canonical(response.url||key);
        const anchors=[...doc.querySelectorAll('a[href]')].filter(a=>{try{return new URL(a.href).origin===new URL(key).origin&&(canonical(a.href)===key||canonical(a.href)===documentUrl);}catch{return false;}});
        let active=null;for(const anchor of anchors){const li=anchor.closest('li');if(li&&(!active||li.querySelectorAll('a[href]').length>active.querySelectorAll('a[href]').length))active=li;}
        if(!active){
          if(state.scope==='section'){
            const pageUrl=new URL(documentUrl);
            let sectionPrefix=pageUrl.pathname;
            if(/\.[a-z0-9]{1,8}$/i.test(sectionPrefix))sectionPrefix=sectionPrefix.slice(0,sectionPrefix.lastIndexOf('/')+1);
            else if(!sectionPrefix.endsWith('/'))sectionPrefix+='/';
            for(const anchor of doc.querySelectorAll('a[href]')){
              try{
                const url=canonical(anchor.href),target=new URL(url),title=titleOf(anchor).replace(/\s+/g,' ');
                if(target.origin!==pageUrl.origin||!target.pathname.startsWith(sectionPrefix)||url===documentUrl||!title||title.length>160||/\.(pdf|png|jpe?g|svg|zip|tar|gz|css|js)$/i.test(target.pathname))continue;
                if(!items.has(url)){
                  const navPath=[...(parent.navPath||parent.breadcrumbs||[]),{title:parent.title,url:parent.url}];
                  const descriptor={url,title,breadcrumbs:navPath,navPath,parentUrl:parent.url,parentTitle:parent.title,parentSections:[],depth:(Number(parent.depth)||0)+1};
                  items.set(url,descriptor);queue.push(descriptor);
                }
              }catch{}
            }
            continue;
          }
          // Some documentation themes render navigation without nested list markup,
          // or only expose the active page in the sidebar. In that case, collect
          // same-language documentation links from the page and let the queue walk
          // their parent indexes as well.
          const parts=new URL(documentUrl).pathname.split('/').filter(Boolean),language=parts.find(part=>/^[a-z]{2}(?:-[a-z]{2})?$/i.test(part));
          for(const anchor of doc.querySelectorAll('a[href]')){
            try{
              const url=canonical(anchor.href),u=new URL(url),targetParts=u.pathname.split('/').filter(Boolean),targetLanguage=targetParts.find(part=>/^[a-z]{2}(?:-[a-z]{2})?$/i.test(part));
              const title=titleOf(anchor).replace(/\s+/g,' ');
              if(u.origin!==new URL(key).origin||!title||title.length>160||url===documentUrl||(language&&targetLanguage?.toLowerCase()!==language.toLowerCase())||/\.(pdf|png|jpe?g|svg|zip|tar|gz|css|js)$/i.test(u.pathname))continue;
              if(!items.has(url)){
                const parentPath=u.pathname.slice(0,u.pathname.lastIndexOf('/')+1),depth=Math.max(0,targetParts.length-(/\.(html?|php|aspx?)$/i.test(targetParts.at(-1)||'')?1:0));
                const descriptor={url,title,breadcrumbs:[],navPath:[],parentUrl:canonical(`${u.origin}${parentPath}`),parentTitle:'',parentSections:[],depth};items.set(url,descriptor);queue.push(descriptor);
              }
            }catch{}
          }
          continue;
        }
        const walk=(node,parentUrl,parentTitle,parentSections,depth)=>{for(const child of [...node.children]){
          if(child.tagName!=='LI')continue;
          const direct=[...child.querySelectorAll(':scope > a[href],:scope > div > a[href],:scope > p > a[href]')].find(a=>{try{return new URL(a.href).origin===new URL(key).origin;}catch{return false;}});
          let nextUrl=parentUrl,nextTitle=parentTitle,nextSections=parentSections,nextDepth=depth;
          if(direct){const url=canonical(direct.href),title=titleOf(direct);if(title&&url!==parentUrl&&!items.has(url)){
            const descriptor={url,title,breadcrumbs:parent.breadcrumbs||[],navPath:[...(parent.navPath||parent.breadcrumbs||[]),{title:parent.title,url:parent.url},...parentSections.map(title=>({title,url:''}))],parentUrl,parentTitle,parentSections,depth:depth+1};items.set(url,descriptor);queue.push(descriptor);
          }if(title){nextUrl=canonical(direct.href);nextTitle=title;nextSections=[];nextDepth=depth+1;}}
          else{const label=child.querySelector(':scope > label,:scope > span,:scope > div > span'),section=(label?.textContent||'').trim().replace(/\s+/g,' ');if(section){nextSections=[...parentSections,section];nextDepth=depth+1;}}
          for(const nested of [...child.children].filter(el=>['UL','OL'].includes(el.tagName)))walk(nested,nextUrl,nextTitle,nextSections,nextDepth);
        }};
        for(const nested of [...active.children].filter(el=>['UL','OL'].includes(el.tagName)))walk(nested,key,parent.title,parent.parentSections||[],(Number(parent.depth)||0)+1);
      }catch{
        if(scanController.signal.aborted){if(!scanController.__sitedocUserStop)stopReason='Тайм-аут запроса';break;}
      }
    }
    clearTimeout(scanTimeout);
    if(globalThis.__sitedocScanAbort===scanController)delete globalThis.__sitedocScanAbort;
    return{...state,items:[...items.values()],queue,visited:[...visited],stopReason,retryAt:0};
  }});
  if(!injection?.result)throw new Error('Не удалось проверить следующую часть дерева.');
  return injection.result;
}

async function startImport(message){
  const {activeJob}=await chrome.storage.local.get('activeJob');
  if(activeJob?.phase==='running')throw new Error('Другая фоновая операция ещё выполняется.');
  const job={type:'import',phase:'running',tabId:message.tabId,done:0,total:message.items.length,added:0,updated:0,failed:0,incompleteAssets:0,startedAt:Date.now()};
  const state={tabId:message.tabId,items:message.items,collectionId:message.collectionId,updateExisting:message.updateExisting,offset:0,job,stopReason:''};
  await chrome.storage.local.set({importProgress:state,activeJob:job});
  await scheduleResume();
  void processImport();
}

async function processImport(){
  if(importRunning)return;importRunning=true;
  try{
    while(true){
      const {importProgress:state}=await chrome.storage.local.get('importProgress');
      if(!state)break;
      if(state.retryAt&&state.retryAt>Date.now()){await chrome.alarms.create(RESUME_ALARM,{when:state.retryAt});break;}
      if(state.offset>=state.items.length||state.stopReason){
        await chrome.storage.local.set({activeJob:{...state.job,phase:'complete',stopReason:state.stopReason,finishedAt:Date.now()}});
        await chrome.storage.local.remove('importProgress');break;
      }
      const item=state.items[state.offset];
      const result=await importPage(state.tabId,item,state.collectionId,state.updateExisting,state.job);
      const next={...state,offset:result.retryAt?state.offset:state.offset+1,job:result.job,stopReason:'',retryAt:result.retryAt||0,retryCount:result.retryAt?(Number(state.retryCount)||0)+1:0};
      await chrome.storage.local.set({importProgress:next,activeJob:{...next.job,done:next.offset,stopReason:next.stopReason}});
    }
  }catch(error){
    const {importProgress:state}=await chrome.storage.local.get('importProgress');
    if(state){await chrome.storage.local.set({activeJob:{...state.job,phase:'error',error:error.message,finishedAt:Date.now()}});await chrome.storage.local.remove('importProgress');}
  }finally{importRunning=false;await clearResumeIfIdle();}
}

async function importPage(tabId,descriptor,collectionId,updateExisting,previousJob){
  const [injection]=await chrome.scripting.executeScript({target:{tabId},args:[[descriptor],Number(previousJob.retryCount)||0],func:async (descriptors,retryCount)=>{
    const output=[];let stopReason='',retryAt=0,lastRequestAt=0;const offlineMissingAssets=new Set();const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const deferFor=response=>{const retryAfter=response.headers.get('Retry-After');const wait=retryAfter?( /^\d+$/.test(retryAfter)?Number(retryAfter)*1000:Math.max(0,Date.parse(retryAfter)-Date.now()) ):Math.min(60*60*1000,5*60*1000*2**Math.min(retryCount||0,4));retryAt=Date.now()+Math.max(60*1000,wait);stopReason=`HTTP ${response.status}`;};
    const politeFetch=async(...args)=>{if(lastRequestAt)await pause(Math.max(0,1000-(Date.now()-lastRequestAt)));const response=await fetch(...args);lastRequestAt=Date.now();return response;};
    for(const descriptor of descriptors){const {url}=descriptor;try{
      const response=await politeFetch(url,{credentials:'include'});
      if(response.status>=500||[408,425,429].includes(response.status)){
        deferFor(response);break;
      }
      if([401,403].includes(response.status)){stopReason=`HTTP ${response.status}`;output.push({url,error:`Требуется доступ к странице (${stopReason})`});break;}
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const doc=new DOMParser().parseFromString(await response.text(),'text/html'),root=doc.querySelector('main,article,[role="main"]')||doc.body,copy=root.cloneNode(true);
      copy.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,button,[role="navigation"]').forEach(node=>node.remove());
      const dataUrlCache=new Map();
      const dataUrl=source=>{if(dataUrlCache.has(source))return dataUrlCache.get(source);const request=(async()=>{try{const r=await politeFetch(source,{credentials:'include'});if(r.status>=500||[408,425,429].includes(r.status)){deferFor(r);return null;}if(!r.ok){offlineMissingAssets.add(source);return null;}const blob=await r.blob();return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>{offlineMissingAssets.add(source);resolve(null);};reader.readAsDataURL(blob);});}catch{offlineMissingAssets.add(source);return null;}})();dataUrlCache.set(source,request);return request;};
      for(const image of copy.querySelectorAll('img')){const srcset=image.getAttribute('data-srcset')||image.getAttribute('srcset')||image.parentElement?.querySelector('source[srcset]')?.getAttribute('srcset')||'',largest=srcset.split(',').map(candidate=>candidate.trim().split(/\s+/)).filter(candidate=>candidate[0]).sort((a,b)=>parseFloat(b[1])-parseFloat(a[1]))[0]?.[0],raw=image.getAttribute('data-src')||image.getAttribute('data-original')||image.getAttribute('data-lazy-src')||largest||image.getAttribute('src');if(!raw)continue;const absolute=new URL(raw,url).href;image.setAttribute('src',absolute);image.removeAttribute('srcset');image.removeAttribute('loading');const embedded=await dataUrl(absolute);if(embedded){image.setAttribute('src',embedded);if(image.parentElement?.tagName==='PICTURE')image.parentElement.querySelectorAll('source').forEach(node=>node.removeAttribute('srcset'));}if(stopReason)break;}
      const headings=[...copy.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h,i)=>{if(!h.id)h.id=`sitedoc-heading-${i+1}`;return{id:h.id,title:(h.textContent||'').trim(),level:Number(h.tagName.slice(1))};}).filter(h=>h.title);
      const crumbs=doc.querySelector('[aria-label*="breadcrumb" i],.breadcrumb,.breadcrumbs'),breadcrumbs=crumbs?[...crumbs.querySelectorAll('a,[aria-current="page"]')].map(a=>({title:(a.textContent||'').trim(),url:a.href})).filter(x=>x.title):[];
      const embedCss=async(css,base)=>{const resources=[...new Set([...css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)].map(match=>match[1].trim()).filter(source=>!source.startsWith('data:')&&!source.startsWith('#')))];for(const source of resources){const absolute=new URL(source,base).href;const embedded=await dataUrl(absolute);css=css.split(source).join(embedded||absolute);if(stopReason)break;}return css;};
      const styles=[];
      for(const style of doc.querySelectorAll('style'))styles.push({href:url,css:await embedCss(style.textContent||'',url)});
      for(const link of doc.querySelectorAll('link[rel="stylesheet"][href]')){if(stopReason)break;const href=new URL(link.getAttribute('href'),url).href;try{const r=await politeFetch(href,{credentials:'include'});if(r.status>=500||[408,425,429].includes(r.status)){deferFor(r);break;}if(r.ok)styles.push({href,css:await embedCss(await r.text(),href)});}catch{}}
      for(const node of copy.querySelectorAll('[style*="url("]')){let inline=node.getAttribute('style')||'';inline=await embedCss(inline,url);node.setAttribute('style',inline);}
      output.push({title:doc.title||(headings[0]?.title)||url,url,html:copy.innerHTML,text:copy.innerText||copy.textContent||'',headings,breadcrumbs,navPath:descriptor.navPath||descriptor.breadcrumbs||[],parentUrl:descriptor.parentUrl||null,parentSections:descriptor.parentSections||[],styles,siteTitle:doc.querySelector('meta[property="og:site_name"]')?.content||new URL(url).hostname,offlineMissingAssets:[...offlineMissingAssets]});if(stopReason)break;
    }catch(error){output.push({url,error:error.message});}}
    return{pages:output,stopReason,retryAt};
  }});
  const result=injection?.result||{pages:[{url:descriptor.url,error:'Не удалось получить результат страницы.'}]};
  const job={...previousJob};
  // A transient server response has no page data to commit. Avoid reading and
  // rewriting the growing library for every retry attempt.
  if(result.retryAt){job.retryCount=(Number(job.retryCount)||0)+1;return{job,stopReason:result.stopReason||'',retryAt:result.retryAt};}
  let collections=await SiteDocStore.getCollections();
  const collection=collections.find(item=>item.id===collectionId);if(!collection)throw new Error('Выбранная библиотека больше не существует.');
  for(const page of result.pages||[]){if(page.error){job.failed++;continue;}const outcome=savePage(collection,page,updateExisting);if(outcome==='added')job.added++;else if(outcome==='updated')job.updated++;job.incompleteAssets=(Number(job.incompleteAssets)||0)+(page.offlineMissingAssets?.length||0);}
  const collectionIndex=collections.findIndex(item=>item.id===collectionId);collections[collectionIndex]=collection;
  await SiteDocStore.saveCollections(collections);
  return{job,stopReason:result.stopReason||'',retryAt:result.retryAt||0};
}

async function resumeTasks(){
  const saved=await chrome.storage.local.get(['scanProgress','importProgress']);
  if(saved.scanProgress)void processScan();else if(saved.importProgress)void processImport();else await chrome.alarms.clear(RESUME_ALARM);
}

function normTitle(value){return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\.(html?|php|aspx?)$/i,'').replace(/[^a-z0-9]+/g,' ').trim();}
function inferPath(data){const breadcrumbs=data.breadcrumbs||[],navPath=data.navPath||[];const signals=[...breadcrumbs,...navPath].filter(item=>item?.title);const selected=signals.length?(breadcrumbs.length>=navPath.length?breadcrumbs:navPath):[];return selected.filter((item,index)=>index===0||normTitle(item.title)!==normTitle(selected[index-1].title));}
function savePage(collection,data,update){const url=canonical(data.url),duplicate=collection.items.find(item=>item.kind!=='section'&&canonical(item.url)===url);if(duplicate){if(!update)return'skipped';Object.assign(duplicate,data,{updatedAt:Date.now()});return'updated';}
  // Build each breadcrumb level under its parent so identically named sections
  // in different branches remain distinct while repeated imports reuse sections.
  let parentId=null;if(data.parentUrl){const parent=collection.items.find(item=>item.kind!=='section'&&canonical(item.url)===canonical(data.parentUrl));if(parent){parentId=parent.id;for(const title of data.parentSections||[]){let section=collection.items.find(item=>item.kind==='section'&&item.parentId===parentId&&normTitle(item.title)===normTitle(title));if(!section){section={id:crypto.randomUUID(),kind:'section',parentId,title,addedAt:Date.now()};collection.items.push(section);}parentId=section.id;}}}
  if(!parentId)for(const crumb of inferPath(data)){let section=collection.items.find(item=>item.kind==='section'&&item.parentId===parentId&&normTitle(item.title)===normTitle(crumb.title));if(!section){section={id:crypto.randomUUID(),kind:'section',parentId,title:crumb.title,url:crumb.url||'',addedAt:Date.now()};collection.items.push(section);}parentId=section.id;}
  collection.items.push({...data,hierarchyPath:inferPath(data).map(item=>item.title),id:crypto.randomUUID(),parentId,addedAt:Date.now()});return'added';}
