import { registerScrollClient, requestScrollFrame, type ScrollFrame } from './scroll-frame';

/** A real field record follows native scroll through one measured, pinned scene. */
const opening = document.querySelector<HTMLElement>('#opening');
const journey = document.querySelector<HTMLElement>('#journey');
const map = document.querySelector<SVGSVGElement>('#pvMap');
const preview = document.querySelector<HTMLElement>('#preview');
const readout = document.querySelector<HTMLElement>('.journey-readout');
const chapters = [...document.querySelectorAll<HTMLElement>('.journey-chapter')];
const stage = document.querySelector<HTMLElement>('.journey-stage');
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const between = (p: number, a: number, b: number) => clamp((p-a)/(b-a));
const ease = (p: number) => p*p*(3-2*p);
const names = ['Satellite','Field','Evidence'];
let observations: {states:string;passes:string[];camera:{cx:number;cy:number;span:number}} | null = null;
let shownPass = -1;
let geometryDirty = true;
let settings = -1;
let lastProgress = -1;
let lastPinned = false;
let lastChapter = -1;
let lastOpening = -1;
let geometry = { height:600, width:700, readout:240, borderX:2, borderY:2, staticMapHeight:240 };

export function setJourneyField(states:string,passes:string[],camera:{cx:number;cy:number;span:number}) {
  observations = {states,passes,camera};
  shownPass = -1;
  geometryDirty = true;
  showPass(passes.length-1);
  requestScrollFrame();
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
function activate(index:number,pinned:boolean) {
  if (!journey) return;
  journey.dataset.chapter=String(index);
  if(stage) stage.textContent=names[index];
  chapters.forEach((chapter,i)=>{
    const hidden = pinned && i!==index;
    if (hidden && chapter.contains(document.activeElement)) journey.focus({preventScroll:true});
    chapter.inert=hidden;
    chapter.setAttribute('aria-hidden',String(hidden));
  });
}
type State = { pinned:boolean; modeChanged:boolean; progress:number; opening:number; geometryChanged:boolean; mapHeight:number; cameraWidth:number; cameraHeight:number };
if (journey && preview) registerScrollClient<State>({
  measure(frame:ScrollFrame) {
    const pinned=frame.width>=1000 && frame.height>=680 && !frame.reducedMotion && frame.fontSize<=24;
    const actualPinned=journey.classList.contains('is-pinned');
    const openingProgress = opening ? clamp(-opening.getBoundingClientRect().top/frame.height) : 0;
    if (pinned!==actualPinned) return {pinned,modeChanged:true,progress:pinned?0:1,opening:openingProgress,geometryChanged:true,mapHeight:0,cameraWidth:0,cameraHeight:0};
    const rect=journey.getBoundingClientRect();
    const progress=pinned?clamp((frame.navHeight-rect.top)/Math.max(1,rect.height-(frame.height-frame.navHeight))):1;
    const needsGeometry=geometryDirty || settings!==frame.settingsVersion || lastPinned!==pinned;
    if (!needsGeometry && progress===lastProgress && openingProgress===lastOpening) return;
    if (needsGeometry) {
      const parent=map?.parentElement;
      const style=parent?getComputedStyle(parent):null;
      geometry={
        height:preview.clientHeight || 600,
        width:preview.clientWidth || 700,
        readout:readout?.scrollHeight ?? 240,
        borderX:style?parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth):2,
        borderY:style?parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth):2,
        staticMapHeight:parent?.clientHeight ?? 240,
      };
      geometryDirty=false;
      settings=frame.settingsVersion;
    }
    const record=ease(between(progress,.64,.88));
    const finalHeight=Math.max(0,Math.min(geometry.height*.32,geometry.height-geometry.readout-80));
    const mapHeight=(geometry.height-68)*(1-record)+finalHeight*record;
    const camera=ease(between(progress,.22,.65));
    const cameraWidth=(observations?.camera.span ?? 1)*(pinned?Math.exp(Math.log(15)*(1-camera)):1);
    const cameraHeight=cameraWidth*(pinned?Math.max(1,mapHeight-geometry.borderY):geometry.staticMapHeight)/Math.max(1,geometry.width-geometry.borderX);
    return {pinned,modeChanged:false,progress,opening:openingProgress,geometryChanged:needsGeometry,mapHeight,cameraWidth,cameraHeight};
  },
  render(state) {
    journey.classList.toggle('is-pinned',state.pinned);
    if (state.modeChanged) {geometryDirty=true;requestScrollFrame();return;}
    if (state.opening!==lastOpening && opening) {
      opening.style.setProperty('--opening-progress',String(state.opening));
      lastOpening=state.opening;
    }
    if (state.progress!==lastProgress || state.pinned!==lastPinned || state.geometryChanged) {
      const progress=state.progress;
      const field=ease(between(progress,.16,.44));
      const record=ease(between(progress,.64,.88));
      const values:Record<string,string>={
        '--journey-progress':String(progress),
        '--orbit-opacity':String(1-field),
        '--orbit-scale':String(1+field*.55),
        '--orbit-y':`${-field*14}%`,
        '--satellite-y':`${-field*120}px`,
        '--satellite-turn':`${-field*24}deg`,
        '--return-offset':String(-progress*380),
        '--map-opacity':String(ease(between(progress,.2,.36))),
        '--map-height':`${state.mapHeight}px`,
        '--map-y':`${(1-field)*100}px`,
        '--map-tilt':`${(1-field)*36}deg`,
        '--map-scale':String(.65+field*.35),
        '--record-opacity':String(record),
        '--record-y':`${(1-record)*100}px`,
      };
      for(const [name,value] of Object.entries(values)) journey.style.setProperty(name,value);
      const index=state.pinned?(progress<.32?0:progress<.7?1:2):0;
      if(index!==lastChapter || state.pinned!==lastPinned) activate(index,state.pinned);
      lastChapter=index;
      if(observations && map){
        const {cx,cy}=observations.camera;
        map.setAttribute('viewBox',`${cx-state.cameraWidth/2} ${cy-state.cameraHeight/2} ${state.cameraWidth} ${state.cameraHeight}`);
        showPass(state.pinned?Math.min(observations.passes.length-1,Math.floor(between(progress,.36,.82)*observations.passes.length)):observations.passes.length-1);
      }
      lastProgress=progress;lastPinned=state.pinned;
    }
  },
});
const resize = new ResizeObserver(()=>{geometryDirty=true;requestScrollFrame();});
if(preview) resize.observe(preview);
if(readout) resize.observe(readout);
