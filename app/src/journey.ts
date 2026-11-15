/** The document scrolls normally; one viewport stays pinned inside the story. */
const opening = document.querySelector<HTMLElement>('#opening');
const journey = document.querySelector<HTMLElement>('#journey');
const pin = document.querySelector<HTMLElement>('.journey-pin');
const map = document.querySelector<SVGSVGElement>('#pvMap');
const preview = document.querySelector<HTMLElement>('#preview');
const readout = document.querySelector<HTMLElement>('.journey-readout');
const chapters = [...document.querySelectorAll<HTMLElement>('.journey-chapter')];
const stage = document.querySelector<HTMLElement>('.journey-stage');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const desktop = matchMedia('(min-width:1000px) and (min-height:680px)');
const clamp = (n: number) => Math.max(0,Math.min(1,n));
const between = (p:number,a:number,b:number) => clamp((p-a)/(b-a));
const ease = (p:number) => p*p*(3-2*p);
const names = ['Satellite','Field','Evidence'];
let scheduled = false;
let lastProgress = 0;
let active = 0;
let observations: {states:string;passes:string[];camera:{cx:number;cy:number;span:number}} | null = null;
let shownPass = -1;

export function setJourneyField(states:string,passes:string[],camera:{cx:number;cy:number;span:number}) {
  observations = {states,passes,camera};
  shownPass = -1;
  showPass(passes.length-1);
  paint(lastProgress);
  schedule();
}
function showPass(index:number) {
  if (!observations || index===shownPass || index<0) return;
  shownPass=index;
  const state = observations.states[index] ?? '-';
  const labels:Record<string,string>={f:'Flooded',d:'Drained',u:'Uncertain','-':'No observation'};
  const colors:Record<string,string>={f:'#244fb6',d:'#bf4429',u:'#66738a','-':'#66738a'};
  const passes=document.querySelectorAll('#pvPasses .pcol');
  const date=passes[index]?.getAttribute('title')?.split(': ')[0] ?? observations.passes[index].slice(0,10);
  const caption=document.querySelector('#journeyAcquisition');
  if(caption) caption.textContent=`${date} · ${labels[state]}`;
  const polygon=document.querySelector<SVGElement>('#pvMap .hf');
  if(polygon){polygon.style.fill=colors[state];polygon.style.stroke=colors[state];}
  passes.forEach((pass,i)=>pass.classList.toggle('is-observed',i===index));
}
function rich() { return desktop.matches && !reduced.matches && !document.documentElement.classList.contains('motion-paused') && parseFloat(getComputedStyle(document.documentElement).fontSize)<=24; }
function activate(index:number,pinned:boolean) {
  active=index;
  if(journey) journey.dataset.chapter=String(index);
  if(stage) stage.textContent=names[index];
  chapters.forEach((chapter,i)=>{
    chapter.inert=pinned && i!==index;
    chapter.setAttribute('aria-hidden',String(pinned && i!==index));
  });
}
function paint(progress:number) {
  if(!journey) return;
  lastProgress=progress;
  const pinned=rich();
  const field=ease(between(progress,.16,.44));
  const record=ease(between(progress,.64,.88));
  const camera=ease(between(progress,.22,.65));
  const viewportHeight=preview?.clientHeight ?? 600;
  // Reserve the actual record height, including wrapped dates and enlarged text.
  const finalMapHeight=Math.max(0,Math.min(viewportHeight*.32,viewportHeight-(readout?.scrollHeight ?? 240)-80));
  const mapHeight=(viewportHeight-68)*(1-record)+finalMapHeight*record;
  const values:Record<string,string>={
    '--journey-progress':String(progress),
    '--orbit-opacity':String(1-field),
    '--orbit-scale':String(1+field*.55),
    '--orbit-y':`${-field*14}%`,
    '--satellite-y':`${-field*120}px`,
    '--satellite-turn':`${-field*24}deg`,
    '--return-offset':String(-progress*380),
    '--map-opacity':String(ease(between(progress,.2,.36))),
    '--map-height':`${mapHeight}px`,
    '--map-y':`${(1-field)*100}px`,
    '--map-tilt':`${(1-field)*36}deg`,
    '--map-scale':String(.65+field*.35),
    '--record-opacity':String(record),
    '--record-y':`${(1-record)*100}px`,
  };
  for(const [name,value] of Object.entries(values)) journey.style.setProperty(name,value);
  activate(progress<.32?0:progress<.7?1:2,pinned);
  if(observations && map){
    const {cx,cy,span}=observations.camera;
    const width=span*(pinned?Math.exp(Math.log(15)*(1-camera)):1);
    const parent=map.parentElement!;
    const ratio=parent.clientHeight/Math.max(1,parent.clientWidth);
    const height=width*ratio;
    map.setAttribute('viewBox',`${cx-width/2} ${cy-height/2} ${width} ${height}`);
    if(pinned) showPass(Math.min(observations.passes.length-1,Math.floor(between(progress,.36,.82)*observations.passes.length)));
  }
}
function render(){
  scheduled=false;
  if(!journey || !pin || document.hidden) return;
  const pinned=rich();
  const changed=journey.classList.contains('is-pinned')!==pinned;
  journey.classList.toggle('is-pinned',pinned);
  const paused=reduced.matches || document.documentElement.classList.contains('motion-paused');
  const nav=document.querySelector('nav[aria-label="Main"]')?.getBoundingClientRect().height ?? 73;
  const box=journey.getBoundingClientRect();
  const progress=clamp((nav-box.top)/Math.max(1,box.height-(innerHeight-nav)));
  if(!paused || changed){
    paint(pinned?progress:1);
    if(opening) opening.style.setProperty('--opening-progress',String(clamp(-opening.getBoundingClientRect().top/innerHeight)));
  }
  if(!pinned){activate(0,false);if(observations)showPass(observations.passes.length-1);}
}
function schedule(){if(scheduled || document.hidden)return;scheduled=true;requestAnimationFrame(render);}
addEventListener('scroll',schedule,{passive:true});
addEventListener('resize',schedule,{passive:true});
addEventListener('pageshow',schedule);
reduced.addEventListener('change',schedule);
desktop.addEventListener('change',schedule);
new MutationObserver(schedule).observe(document.documentElement,{attributes:true,attributeFilter:['class','style']});
document.addEventListener('visibilitychange',schedule);
if(journey){new ResizeObserver(schedule).observe(journey);schedule();}
