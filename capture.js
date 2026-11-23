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
    const dataUrlCache = new Map(), offlineMissingAssets = new Set();
    const toDataUrl = source => {
      if(dataUrlCache.has(source))return dataUrlCache.get(source);
      const request=(async()=>{try {
        if(source.startsWith('blob:')){const blob=await (await fetch(source)).blob();return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>{offlineMissingAssets.add(source);resolve(null);};reader.readAsDataURL(blob);});}
        const result = await chrome.runtime.sendMessage({type:'FETCH_OFFLINE_ASSET',url:source});
        if (!result?.ok) { offlineMissingAssets.add(source); return null; }
        return result.dataUrl;
      } catch { offlineMissingAssets.add(source); return null; }})();
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
        // Cross-origin stylesheets hide cssRules; use the extension worker when page fetch is blocked.
        if(sheet.href)try{
          const response=await fetch(sheet.href,{credentials:'include'});
          if(response.ok){let css=await response.text();const urls=[...new Set([...css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)].map(m=>m[1].trim()).filter(u=>!u.startsWith('data:')&&!u.startsWith('#')))];for(const source of urls){try{const absolute=new URL(source,sheet.href).href;const data=await toDataUrl(absolute);css=css.split(source).join(data||absolute);}catch{}}styles.push({href:sheet.href,css});}else offlineMissingAssets.add(sheet.href);
        }catch{try{const result=await chrome.runtime.sendMessage({type:'FETCH_OFFLINE_ASSET',url:sheet.href,asText:true});if(result?.ok){let css=result.text;const urls=[...new Set([...css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)].map(m=>m[1].trim()).filter(u=>!u.startsWith('data:')&&!u.startsWith('#')))];for(const source of urls){const absolute=new URL(source,sheet.href).href;const data=await toDataUrl(absolute);css=css.split(source).join(data||absolute);}styles.push({href:sheet.href,css});}else offlineMissingAssets.add(sheet.href);}catch{offlineMissingAssets.add(sheet.href);}}
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
    return {title:document.title,url:location.href,html:copy.innerHTML,text:copy.innerText||copy.textContent||'',headings,breadcrumbs,navPath:menuHierarchy.path,parentUrl:menuHierarchy.parentUrl,parentTitle:menuHierarchy.parentTitle,parentSections:menuHierarchy.parentSections,styles,siteTitle:document.querySelector('meta[property="og:site_name"]')?.content||location.hostname,offlineMissingAssets:[...offlineMissingAssets]};
  }});
  return page.result;
}

