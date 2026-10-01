import {installPDFTouchGestures,installPDFWheelZoom} from './reader-touch.mjs';
const $=s=>document.querySelector(s);
let catalog=[],course='all',active=null,viewer=null,eventBus=null,linkService=null,findController=null,loadingTask=null,loadId=0;
const compactReader=matchMedia('(max-width:900px), (max-width:1200px) and (pointer:coarse)');
let fittedWidth=0,refitFrame=0;
const resetTouch=installPDFTouchGestures($('#viewerContainer'),()=>active?viewer:null);
const resetWheel=installPDFWheelZoom($('#reader'),()=>active?viewer:null);
let memory={};try{memory=JSON.parse(localStorage.getItem('shnotes.reading.v1')||'{}')}catch{}
if(!memory||typeof memory!=='object')memory={};
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const name=c=>c==='logic'?'Матлог':'Дискретка';
const pageOf=id=>Math.max(1,Math.min(catalog.find(x=>x.id===id)?.pages||1,Number.isInteger(memory[id]?.page)?memory[id].page:1));
const lectureLabel=x=>x.number==null?'КОНСПЕКТ':`ЛЕКЦИЯ ${String(x.number).padStart(2,'0')}`;
const plural=(n,one,few,many)=>n%10===1&&n%100!==11?one:n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?few:many;
function persist(){try{localStorage.setItem('shnotes.reading.v1',JSON.stringify(memory))}catch{}}
function render(){
 const q=$('#catalog-search').value.toLocaleLowerCase('ru').trim();
 const list=catalog.filter(x=>(course==='all'||x.course===course)&&`${x.title} ${x.description} ${name(x.course)} ${x.number} ${x.lecturer}`.toLocaleLowerCase('ru').includes(q));
 $('#cards').innerHTML=list.map(x=>`<button class="lecture-card ${x.course}" data-id="${x.id}" aria-label="Читать: ${escape(x.title)}"><span class="cover-stage"><img src="${x.cover}" alt="Обложка конспекта ${x.number}" width="536" height="758"></span><span class="card-info"><span class="card-course">${name(x.course)}</span><span class="card-number">${lectureLabel(x)}</span><span class="card-title">${escape(x.title)}</span><span class="card-description">${escape(x.description)}</span><span class="card-bottom"><span>${x.pages} стр. <span aria-hidden="true">·</span> ${memory[x.id]?'Стр. '+pageOf(x.id):'PDF'}</span><span class="card-arrow" aria-hidden="true">↗</span></span></span><span class="card-progress" style="--progress:${memory[x.id]?Math.min(pageOf(x.id)/x.pages*100,100):0}%"></span></button>`).join('');
 $('#result-count').textContent=`${list.length} ${plural(list.length,'КОНСПЕКТ','КОНСПЕКТА','КОНСПЕКТОВ')}`;
 $('#total-pages').textContent=`${list.reduce((s,x)=>s+x.pages,0)} стр.`;
 $('#empty').hidden=!!list.length;
 document.querySelectorAll('[data-course]').forEach(b=>{b.classList.toggle('active',b.dataset.course===course);b.setAttribute('aria-pressed',b.dataset.course===course)});
 document.querySelectorAll('.nav-item[data-course]').forEach(b=>b.querySelector('b').textContent=String(catalog.filter(x=>b.dataset.course==='all'||x.course===b.dataset.course).length).padStart(2,'0'));
 const last=catalog.find(x=>x.id===memory.last);
 $('#resume').hidden=!last;
 if(last){$('#resume-title').textContent=last.title;$('#resume-page').textContent=`Стр. ${pageOf(last.id)} из ${last.pages}`;}
}
document.querySelectorAll('[data-course]').forEach(b=>b.onclick=()=>{course=b.dataset.course;$('#breadcrumb').textContent=course==='all'?'БИБЛИОТЕКА':course==='logic'?'МАТЛОГ':'ДИСКРЕТКА';render()});
$('#catalog-search').oninput=render;
$('#cards').onclick=e=>{const b=e.target.closest('[data-id]');if(b)location.hash=`read/${b.dataset.id}`};
$('#resume').onclick=()=>{location.hash=`read/${memory.last}`};
$('#back').onclick=()=>{location.hash='';};
async function initViewer(){
 if(viewer)return;
 const pdfjs=await import('./vendor/build/pdf.mjs');
 globalThis.pdfjsLib=pdfjs;
 pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/build/pdf.worker.mjs',import.meta.url).href;
 const ui=await import('./vendor/web/pdf_viewer.mjs');
 eventBus=new ui.EventBus();linkService=new ui.PDFLinkService({eventBus});findController=new ui.PDFFindController({eventBus,linkService});
 viewer=new ui.PDFViewer({container:$('#viewerContainer'),viewer:$('#viewer'),eventBus,linkService,findController,annotationEditorMode:-1,removePageBorders:true});
 linkService.setViewer(viewer);
 eventBus.on('pagesinit',()=>{if(!active)return;fittedWidth=$('#viewerContainer').clientWidth;viewer.currentScaleValue='page-width';viewer.currentPageNumber=Math.min(active.pages,Math.max(1,active.initialPage));});
 eventBus.on('pagerendered',()=>{$('#reader-status').hidden=true});
 eventBus.on('pagechanging',({pageNumber})=>{if(!active)return;updatePage(pageNumber)});
 eventBus.on('scalechanging',({scale,presetValue})=>{$('#fit').textContent=presetValue==='page-width'?(innerWidth<=560?'Ширина':'По ширине'):`${Math.round(scale*100)}%`});
 eventBus.on('updatefindmatchescount',({matchesCount})=>{$('#find-results').textContent=`${matchesCount.current} / ${matchesCount.total}`});
 eventBus.on('updatefindcontrolstate',({state,matchesCount})=>{$('#find-results').textContent=state===1?'Не найдено':state===3?'Поиск…':`${matchesCount?.current||0} / ${matchesCount?.total||0}`});
}
function updatePage(page){
 $('#page-number').value=page;$('#previous').disabled=page<=1;$('#next').disabled=page>=active.pages;
 $('#progress-label').textContent=`${page} / ${active.pages}`;$('#progress-bar').style.width=`${page/active.pages*100}%`;
 memory[active.id]={page};memory.last=active.id;persist();
 const buttons=[...$('#outline').querySelectorAll('button')];let selected=null;for(const b of buttons){b.classList.remove('active');if(+b.dataset.page<=page)selected=b}selected?.classList.add('active');
 const url=new URL(location.href);url.hash=`read/${active.id}/${page}`;history.replaceState(null,'',url);
}
async function openReader(item,page){
 const thisLoad=++loadId;
 resetTouch();resetWheel();
 active={...item,initialPage:page||pageOf(item.id)};
 $('#library').hidden=true;$('#reader').hidden=false;document.body.style.overflow='hidden';
 $('#reader').classList.remove('focus');$('#focus-mode').setAttribute('aria-pressed','false');
 setOutline(!compactReader.matches);
 $('#reader-title').textContent=item.title;$('#reader-title').title=item.title;$('#reader-course').textContent=`${name(item.course)} / ${lectureLabel(item)}`;
 document.title=`${item.title} — SH Notes`;
 $('#download').href=item.file;$('#page-count').textContent=item.pages;$('#page-number').max=item.pages;
 $('#outline-count').textContent=item.outline.filter(x=>x.level===1).length;
 $('#outline').innerHTML=item.outline.length?item.outline.map(x=>`<button class="${x.level>1?'sub':''}" data-page="${x.page}"><span>${escape(x.title)}</span><small>${x.page}</small></button>`).join(''):'<p class="outline-empty">В этом PDF нет оглавления. Используйте номера страниц или поиск.</p>';
 $('#reader-status').textContent='Открываем конспект…';$('#reader-status').hidden=false;$('#findbar').hidden=true;$('#find-input').value='';
 try{
  await initViewer();if(thisLoad!==loadId)return;
  if(loadingTask){const previousTask=loadingTask;loadingTask=null;viewer.setDocument(null);linkService.setDocument(null);await previousTask.destroy();}
  if(thisLoad!==loadId)return;
  loadingTask=globalThis.pdfjsLib.getDocument({url:item.file,cMapUrl:'vendor/cmaps/',cMapPacked:true,standardFontDataUrl:'vendor/standard_fonts/',wasmUrl:'vendor/wasm/',enableScripting:false});
  const doc=await loadingTask.promise;if(thisLoad!==loadId)return;
  viewer.setDocument(doc);linkService.setDocument(doc);updatePage(Math.min(item.pages,Math.max(1,active.initialPage)));
 }catch(err){if(thisLoad!==loadId)return;$('#reader-status').textContent='Не удалось открыть читалку. Скачайте PDF кнопкой справа вверху.';console.error(err)}
}
function route(){const m=location.hash.match(/^#read\/([a-z0-9-]+)(?:\/(\d+))?$/);const item=m&&catalog.find(x=>x.id===m[1]);if(item){openReader(item,+m[2]||0)}else{loadId++;resetTouch();resetWheel();active=null;$('#reader').hidden=true;$('#library').hidden=false;document.body.style.overflow='';document.title='SH Notes — Библиотека';render();}}
window.addEventListener('hashchange',route);
$('#outline').onclick=e=>{const b=e.target.closest('[data-page]');if(b&&viewer?.pdfDocument){viewer.currentPageNumber=+b.dataset.page;if(compactReader.matches)setOutline(false)}};
$('#previous').onclick=()=>{if(viewer?.pdfDocument)viewer.currentPageNumber=Math.max(1,viewer.currentPageNumber-1)};
$('#next').onclick=()=>{if(viewer?.pdfDocument)viewer.currentPageNumber=Math.min(active.pages,viewer.currentPageNumber+1)};
$('#page-number').onchange=e=>{if(viewer?.pdfDocument){viewer.currentPageNumber=Math.max(1,Math.min(active.pages,Math.floor(+e.target.value||1)));e.target.value=viewer.currentPageNumber}};
function zoom(factor){if(viewer?.pdfDocument){const bounds=$('#viewerContainer').getBoundingClientRect();viewer.updateScale({scaleFactor:Math.max(.1,Math.min(4,viewer.currentScale*factor))/viewer.currentScale,origin:[bounds.left+bounds.width/2,bounds.top+bounds.height/2]})}}
$('#zoom-out').onclick=()=>zoom(1/1.15);
$('#zoom-in').onclick=()=>zoom(1.15);
$('#fit').onclick=()=>{if(viewer?.pdfDocument)viewer.currentScaleValue='page-width'};
function refit(){if(refitFrame)return;refitFrame=requestAnimationFrame(()=>{refitFrame=0;if(!active||!viewer?.pdfDocument)return;const width=$('#viewerContainer').clientWidth;if(width===fittedWidth)return;fittedWidth=width;if(viewer.currentScaleValue==='page-width')viewer.currentScaleValue='page-width'})}
function setOutline(open){$('#reader').classList.toggle('no-outline',!open);$('#toggle-outline').setAttribute('aria-expanded',String(open));refit()}
$('#toggle-outline').onclick=()=>{$('#reader').classList.remove('focus');$('#focus-mode').setAttribute('aria-pressed','false');setOutline($('#reader').classList.contains('no-outline'))};
$('#outline-dismiss').onclick=()=>setOutline(false);
$('#focus-mode').onclick=()=>{$('#reader').classList.toggle('focus');$('#focus-mode').setAttribute('aria-pressed',$('#reader').classList.contains('focus'));refit()};
new ResizeObserver(refit).observe($('#viewerContainer'));
compactReader.addEventListener('change',e=>{if(active&&e.matches)setOutline(false)});
function find(type='',previous=false){if(!eventBus)return;eventBus.dispatch('find',{source:window,type,query:$('#find-input').value,phraseSearch:true,caseSensitive:false,entireWord:false,highlightAll:true,findPrevious:previous,matchDiacritics:false});}
function showFind(){$('#findbar').hidden=false;$('#find-input').focus()}
function closeFind(){$('#findbar').hidden=true;eventBus?.dispatch('findbarclose',{source:window});$('#toggle-find').focus()}
$('#toggle-find').onclick=()=>$('#findbar').hidden?showFind():closeFind();
$('#find-close').onclick=closeFind;
$('#find-input').oninput=()=>find();$('#find-input').onkeydown=e=>{if(e.key==='Enter')find('again',e.shiftKey)};
$('#find-next').onclick=()=>find('again');$('#find-prev').onclick=()=>find('again',true);
document.addEventListener('keydown',e=>{if(active&&(e.ctrlKey||e.metaKey)&&e.key==='f'){e.preventDefault();showFind()}if(e.key==='Escape'&&active){if(!$('#findbar').hidden)closeFind();else if($('#reader').classList.contains('focus')){$('#reader').classList.remove('focus');$('#focus-mode').setAttribute('aria-pressed','false');refit()}else if(compactReader.matches&&!$('#reader').classList.contains('no-outline'))setOutline(false)}
 if(!active&&e.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){e.preventDefault();$('#catalog-search').focus()}});
try{const response=await fetch('catalog.json',{cache:'no-cache'});if(!response.ok)throw Error('Catalog unavailable');catalog=await response.json();render();route()}catch(e){$('#cards').innerHTML='<p class="empty">Библиотека временно недоступна. Обновите страницу или откройте репозиторий.</p>';console.error(e)}
