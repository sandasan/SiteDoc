const $ = s => document.querySelector(s);
let collections = [], selectedCollection = '', selectedPage = '';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const current = () => collections.find(c => c.id === selectedCollection);
const items = () => current()?.items || [];
const persist = () => chrome.storage.local.set({ collections });

async function init() {
  ({ collections = [] } = await chrome.storage.local.get('collections'));
  if (!collections.length) { collections = [{ id: crypto.randomUUID(), title: 'Моя библиотека', items: [] }]; await persist(); }
  selectedCollection = collections[0].id; render();
}
function render() {
  $('#collections').innerHTML = collections.map(c => `<option value="${c.id}" ${c.id === selectedCollection ? 'selected' : ''}>${esc(c.title)} (${c.items.length})</option>`).join('');
  const list = items();
  $('#outline').innerHTML = list.map((p, i) => {
    let level = 0, parent = p.parentId;
    while (parent && level < 3) { level++; parent = list.find(x => x.id === parent)?.parentId; }
    level = Math.min(3, level);
    return `<li><div class="outline-item indent-${level} ${p.id === selectedPage ? 'active' : ''}" data-id="${esc(p.id)}"><span class="tree-title" title="${esc(p.url || p.title)}">${p.kind === 'section' ? '▸ ' : ''}${esc(p.title)}</span><button class="icon-button" data-act="up" title="Вверх">↑</button><button class="icon-button" data-act="down" title="Вниз">↓</button><button class="icon-button" data-act="indent" title="Вложить в предыдущую">↳</button></div></li>`;
  }).join('') || '<li class="empty small">В этой коллекции пока нет страниц. Откройте страницу и добавьте её через значок расширения.</li>';
  $('#outline').querySelectorAll('.outline-item').forEach(row => row.addEventListener('click', e => {
    const id = row.dataset.id, act = e.target.dataset.act;
    if (act) { e.stopPropagation(); move(id, act); } else { selectedPage = id; render(); }
  }));
  const p = list.find(x => x.id === selectedPage);
  $('#empty').hidden = !!p; $('#page').hidden = !p;
  if (p) {
    $('#editorHeading').textContent = p.kind === 'section' ? 'Раздел' : 'Страница';
    $('#title').value = p.title; $('#url').value = p.url || '';
    $('#url').hidden = p.kind === 'section';
    $('#content').textContent = p.kind === 'section' ? 'Раздел в оглавлении. Страницы с такими же хлебными крошками будут добавляться сюда автоматически.' : (p.text || '(Текст на этой странице не найден.)');
  }
}
function move(id, action) {
  const a = items(), i = a.findIndex(p => p.id === id); if (i < 0) return;
  if (action === 'up' && i > 0) [a[i-1], a[i]] = [a[i], a[i-1]];
  if (action === 'down' && i < a.length-1) [a[i+1], a[i]] = [a[i], a[i+1]];
  if (action === 'indent' && i > 0) {
    const proposedParent = a[i-1];
    let ancestor = proposedParent, createsCycle = ancestor.id === id;
    while (ancestor.parentId && !createsCycle) { ancestor = a.find(item => item.id === ancestor.parentId); createsCycle = ancestor?.id === id; if (!ancestor) break; }
    if (!createsCycle) a[i].parentId = proposedParent.id;
  }
  persist().then(render);
}
$('#collections').addEventListener('change', e => { selectedCollection = e.target.value; selectedPage = ''; render(); });
$('#addCollection').addEventListener('click', async () => { const title = $('#newCollection').value.trim(); if (!title) return; const c = { id: crypto.randomUUID(), title, items: [] }; collections.push(c); selectedCollection = c.id; selectedPage = ''; $('#newCollection').value = ''; await persist(); render(); });
$('#title').addEventListener('change', async e => { const p = items().find(x => x.id === selectedPage); if (p) { p.title = e.target.value.trim() || p.title; await persist(); render(); } });
$('#url').addEventListener('change', async e => { const p = items().find(x => x.id === selectedPage); if (p) { p.url = e.target.value; await persist(); } });
$('#up').onclick = () => move(selectedPage, 'up'); $('#down').onclick = () => move(selectedPage, 'down'); $('#indent').onclick = () => move(selectedPage, 'indent');
$('#outdent').onclick = async () => { const p = items().find(x => x.id === selectedPage); if (p) { p.parentId = null; await persist(); render(); } };
$('#delete').onclick = async () => { const c = current(), remove = new Set([selectedPage]); let changed = true; while (changed) { changed = false; for (const p of c.items) if (remove.has(p.parentId) && !remove.has(p.id)) { remove.add(p.id); changed = true; } } c.items = c.items.filter(p => !remove.has(p.id)); selectedPage = ''; await persist(); render(); };
$('#exportPdf').onclick = () => { const c = current(); if (!c?.items.length) return; const w = window.open('', '_blank'); w.document.write(printDocument(c)); w.document.close(); w.focus(); setTimeout(() => w.print(), 500); };
function printDocument(c) {
  const pages = c.items.filter(p => p.kind !== 'section');
  const nestedContents = parent => c.items.filter(p => (p.parentId || null) === parent).map(p => {
    const sub = nestedContents(p.id);
    if (p.kind === 'section') return `<li>${esc(p.title)}${sub ? `<ol>${sub}</ol>` : ''}</li>`;
    const i = pages.indexOf(p);
    return `<li><a href="#page-${i}">${esc(p.title)}</a>${sub ? `<ol>${sub}</ol>` : ''}<ul>${(p.headings || []).filter(h => h.title).map(h => `<li><a href="#page-${i}-${encodeURIComponent(h.id)}">${esc(h.title)}</a></li>`).join('')}</ul></li>`;
  }).join('');
  const rows = pages.map((p,i) => {
    const body = p.html || `<pre>${esc(p.text || '')}</pre>`;
    const css = (p.styles || []).map(s => s.css).filter(Boolean).join('\n').replace(/<\/style/gi,'<\\/style');
    return `<article id="page-${i}"><h1>${esc(p.title)}</h1><p class="source"><a href="${esc(p.url)}">${esc(p.url)}</a></p><style>${css}</style><main>${body}</main></article>`;
  }).join('');
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${esc(c.title)}</title><style>body{font:12pt/1.55 Georgia,serif;color:#222}article{max-width:900px;margin:0 auto;break-before:page}article:first-of-type{break-before:auto}article img{max-width:100%;height:auto}h1,h2,h3,h4{break-after:avoid}.source{font:9pt sans-serif;color:#666;overflow-wrap:anywhere}#contents{max-width:900px;margin:0 auto;break-after:page}#contents ul,#contents ol{padding-left:1.5em}a{color:inherit}@media screen{body{padding:24px}}@page{margin:18mm}</style><section id="contents"><h1>${esc(c.title)}</h1><h2>Содержание</h2><ol>${nestedContents(null)}</ol></section>${rows}</html>`;
}

// Small dependency-free ZIP writer (stored entries) for EPUB 3 export.
const crcTable = (() => { const t = new Uint32Array(256); for (let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t; })();
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function zip(files){const enc=new TextEncoder(), local=[], central=[];let offset=0;for(const f of files){const name=enc.encode(f.name),data=typeof f.data==='string'?enc.encode(f.data):f.data,crc=crc32(data),lh=new Uint8Array(30+name.length),lv=new DataView(lh.buffer);lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint32(14,crc,true);lv.setUint32(18,data.length,true);lv.setUint32(22,data.length,true);lv.setUint16(26,name.length,true);lh.set(name,30);local.push(lh,data);const ch=new Uint8Array(46+name.length),cv=new DataView(ch.buffer);cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint32(16,crc,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);ch.set(name,46);central.push(ch);offset+=lh.length+data.length;}const centralSize=central.reduce((n,x)=>n+x.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,files.length,true);v.setUint16(10,files.length,true);v.setUint32(12,centralSize,true);v.setUint32(16,offset,true);return new Blob([...local,...central,end],{type:'application/epub+zip'});}
function epub(c){
  const uid=crypto.randomUUID(), enc=s=>esc(s), list=c.items, pages=list.filter(p=>p.kind!=='section');
  const manifest=pages.map((p,i)=>`<item id="p${i}" href="p${i}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const spine=pages.map((p,i)=>`<itemref idref="p${i}"/>`).join('');
  const children=parent=>list.filter(p=>(p.parentId||null)===parent);
  const firstPage=p=>p.kind!=='section'?pages.indexOf(p):children(p.id).map(firstPage).find(i=>i>=0)??-1;
  const navTree=parent=>children(parent).map(p=>{
    const i=firstPage(p), nested=navTree(p.id);
    if(i<0)return '';
    const headingToc=p.kind==='section'?'':(p.headings||[]).filter(h=>h.title).map(h=>`<li><a href="p${i}.xhtml#${enc(h.id)}">${enc(h.title)}</a></li>`).join('');
    const childContent=`${headingToc}${nested}`;
    return `<li><a href="p${i}.xhtml">${enc(p.title)}</a>${childContent?`<ol>${childContent}</ol>`:''}</li>`;
  }).join('');
  const files=[
    {name:'mimetype',data:'application/epub+zip'},
    {name:'META-INF/container.xml',data:'<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'},
    {name:'OEBPS/nav.xhtml',data:`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${enc(c.title)}</title></head><body><nav epub:type="toc"><h1>${enc(c.title)}</h1><ol>${navTree(null)}</ol></nav></body></html>`},
    ...pages.map((p,i)=>{
      const assets=[];
      const localizeDataImages=source=>source.replace(/data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)/gi,(match,mime,b64)=>{
        const ext=({ 'image/jpeg':'jpg','image/svg+xml':'svg' })[mime.toLowerCase()]||mime.split('/')[1].split('+')[0];
        const href=`images/p${i}-${assets.length}.${ext}`;
        const binary=atob(b64), bytes=new Uint8Array(binary.length);
        for(let n=0;n<binary.length;n++)bytes[n]=binary.charCodeAt(n);
        assets.push({href,mime:mime.toLowerCase(),bytes});
        return href;
      });
      const siteCss=(p.styles||[]).map(s=>s.css).filter(Boolean).join('\n');
      // Rewrite CSS relative URLs to absolute source URLs. Embedded images remain data URIs.
      let css=siteCss.replace(/url\((['"]?)(?!data:|https?:|\/|#)([^'"\)]+)\1\)/gi,(m,q,path)=>`url("${new URL(path,(p.styles||[]).find(s=>s.css.includes(m))?.href||p.url).href}")`);
      css=localizeDataImages(css);
      const body=localizeDataImages(p.html||`<pre>${enc(p.text||'')}</pre>`);
      const assetItems=assets.map((a,n)=>`<item id="img${i}-${n}" href="${a.href}" media-type="${a.mime}"/>`).join('');
      const xhtml=`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ru"><head><title>${enc(p.title)}</title><meta charset="utf-8"/><style>${enc(css.replace(/<\/style/gi,'<\\/style'))}</style><style>body{font-family:serif;line-height:1.55}img{max-width:100%;height:auto}a{overflow-wrap:anywhere}</style></head><body><header class="sitedoc-source"><h1>${enc(p.title)}</h1><p><a href="${enc(p.url)}">${enc(p.url)}</a></p></header><main>${body}</main></body></html>`;
      return [{name:`OEBPS/p${i}.xhtml`,data:xhtml},...assets.map(a=>({name:`OEBPS/${a.href}`,data:a.bytes})),{name:`OEBPS/.manifest-${i}.xml`,data:assetItems}];
    })
  ].flat();
  // Move image entries into the package manifest alongside each page.
  const assetManifest=files.filter(f=>f.name.endsWith('.manifest.xml')).map(f=>f.data).join('');
  const cleanFiles=files.filter(f=>!f.name.endsWith('.manifest.xml'));
  cleanFiles.push({name:'OEBPS/content.opf',data:`<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="ru"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:${uid}</dc:identifier><dc:title>${enc(c.title)}</dc:title><dc:language>ru</dc:language><meta property="dcterms:modified">${new Date().toISOString().slice(0,19)}Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>${manifest}${assetManifest}</manifest><spine>${spine}</spine></package>`});
  return zip(cleanFiles);
}
$('#exportEpub').onclick = async () => { const c = current(); if (!c?.items.length) return; const blob=epub(c), url=URL.createObjectURL(blob); await chrome.downloads.download({url,filename:`${c.title.replace(/[\\/:*?"<>|]/g,'_')}.epub`,saveAs:true}); setTimeout(()=>URL.revokeObjectURL(url),60000); };
init();
