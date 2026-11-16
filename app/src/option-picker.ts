/** Bounded option menus keep large field collections inside the viewport. */
import './option-picker.css';
const dialog=document.createElement('dialog'); dialog.id='optionPicker';dialog.setAttribute('aria-labelledby','optionHeading');
dialog.innerHTML='<form method="dialog"><label id="optionHeading" for="optionQuery">Find an option</label><button class="picker-close" aria-label="Close options">×</button></form><input id="optionQuery" type="search" autocomplete="off" placeholder="Type to filter"><p id="optionCount" role="status"></p><div id="optionResults" role="listbox" aria-label="Matching options"></div>';
document.body.append(dialog);
const query=dialog.querySelector<HTMLInputElement>('#optionQuery')!;
const results=dialog.querySelector<HTMLElement>('#optionResults')!;
let source:HTMLSelectElement|null=null;
function render(){
 if(!source)return;
 const options=[...source.options].filter(o=>!o.disabled&&o.value&&o.text.toLowerCase().includes(query.value.toLowerCase()));
 results.replaceChildren();
 for(const o of options.slice(0,40)){
  const b=document.createElement('button');b.type='button';b.role='option';b.setAttribute('aria-selected',String(o.selected));b.textContent=o.text;
  b.onclick=()=>{const target=source!;target.value=o.value;target.dispatchEvent(new Event('input',{bubbles:true}));target.dispatchEvent(new Event('change',{bubbles:true}));dialog.close();if(target.isConnected)target.focus({preventScroll:true});};results.append(b);
 }
 dialog.querySelector('#optionCount')!.textContent=options.length?`${options.length.toLocaleString()} matches${options.length>40?' · Type more to narrow the list':''}`:'No matches. Try another name or ID.';
}
function open(select:HTMLSelectElement){
 source=select;query.value='';dialog.querySelector('#optionHeading')!.textContent=select.id.toLowerCase().includes('field')?'Find a field':'Find an option';render();dialog.showModal();
 const r=select.getBoundingClientRect(),w=Math.min(380,innerWidth-24);
 dialog.style.width=w+'px';const height=dialog.getBoundingClientRect().height;dialog.style.left=Math.max(12,Math.min(r.left,innerWidth-w-12))+'px';
 dialog.style.top=Math.max(16,Math.min(r.bottom+6,innerHeight-height-16))+'px';query.focus();
}
query.oninput=render;
query.onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();results.querySelector<HTMLButtonElement>('button')?.focus();}if(e.key==='Enter'){e.preventDefault();results.querySelector<HTMLButtonElement>('button')?.click();}};
results.onkeydown=e=>{const buttons=[...results.querySelectorAll<HTMLButtonElement>('button')],i=buttons.indexOf(document.activeElement as HTMLButtonElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}};
dialog.addEventListener('close',()=>{const target=source?.isConnected?source:source?.id?document.getElementById(source.id):null;target?.focus({preventScroll:true});});
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
addEventListener('resize',()=>{if(dialog.open)dialog.close();});
document.addEventListener('pointerdown',e=>{const select=(e.target as Element).closest('select');if(select&&select.options.length>8&&!select.disabled){e.preventDefault();open(select);}},true);
document.addEventListener('keydown',e=>{const select=e.target as HTMLSelectElement;if(select.tagName==='SELECT'&&select.options.length>8&&(e.key===' '||(e.altKey&&e.key==='ArrowDown')||(e.key==='Enter'&&select.id!=='fieldPicker'))){e.preventDefault();open(select);}},true);
// Replace the browser's unbounded datalist with a small floating suggestion list.
const suggestions=document.createElement('div');suggestions.id='fieldSuggestions';suggestions.hidden=true;suggestions.setAttribute('role','listbox');suggestions.setAttribute('aria-label','Suggested fields');document.body.append(suggestions);
let search:HTMLInputElement|null=null;
function closeSuggestions(){if(suggestions.contains(document.activeElement))search?.focus({preventScroll:true});suggestions.hidden=true;search?.setAttribute('aria-expanded','false');}
function suggest(input:HTMLInputElement){
 search=input;input.removeAttribute('list');input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls','fieldSuggestions');input.setAttribute('aria-expanded','true');
 suggestions.replaceChildren();for(const o of [...document.querySelectorAll<HTMLOptionElement>('#fieldIds option')].slice(0,20)){
  const b=document.createElement('button');b.type='button';b.role='option';b.setAttribute('aria-selected','false');b.textContent=o.value;b.onpointerdown=e=>e.preventDefault();b.onclick=()=>{input.value=o.value;input.dispatchEvent(new Event('input',{bubbles:true}));closeSuggestions();input.form?.requestSubmit();};suggestions.append(b);
 }
 const r=input.getBoundingClientRect(),w=Math.min(340,innerWidth-24);suggestions.style.width=w+'px';suggestions.style.left=Math.max(12,Math.min(r.left,innerWidth-w-12))+'px';suggestions.style.top=Math.max(12,Math.min(r.bottom+6,innerHeight-260))+'px';suggestions.hidden=!suggestions.childElementCount;input.setAttribute('aria-expanded',String(!suggestions.hidden));
}
function disableNative(){document.querySelector('#searchField')?.removeAttribute('list');}
new MutationObserver(disableNative).observe(document.body,{childList:true,subtree:true});disableNative();
document.addEventListener('input',e=>{if((e.target as Element).id==='searchField')suggest(e.target as HTMLInputElement);});
document.addEventListener('keydown',e=>{if(suggestions.contains(e.target as Node)){const buttons=[...suggestions.querySelectorAll<HTMLButtonElement>('button')],i=buttons.indexOf(document.activeElement as HTMLButtonElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(e.key==='Tab'){e.preventDefault();closeSuggestions();if(!e.shiftKey)search?.form?.querySelector<HTMLButtonElement>('button[type=submit]')?.focus();}}if((e.target as Element).id==='searchField'&&e.key==='ArrowDown'&&!suggestions.hidden){e.preventDefault();suggestions.querySelector<HTMLButtonElement>('button')?.focus();}if(e.key==='Escape')closeSuggestions();});
document.addEventListener('submit',closeSuggestions);
document.addEventListener('pointerdown',e=>{if(!suggestions.contains(e.target as Node)&&(e.target as Element).id!=='searchField')closeSuggestions();});
document.addEventListener('focusin',e=>{if(!suggestions.contains(e.target as Node)&&(e.target as Element).id!=='searchField')closeSuggestions();});
addEventListener('scroll',closeSuggestions,{passive:true});
