/** Scroll observes the page; it never owns scrolling or the data controller. */
const opening = document.querySelector<HTMLElement>("#opening");
const journey = document.querySelector<HTMLElement>("#journey");
const chapters = [...document.querySelectorAll<HTMLElement>(".journey-chapter")];
const instrument = document.querySelector<HTMLElement>(".journey-instrument");
const stage = document.querySelector<HTMLElement>(".journey-stage");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (n: number) => Math.max(0, Math.min(1, n));
let scheduled = false;
let visible = true;
let observations: { states: string; passes: string[] } | null = null;
let shownPass = -1;

/** The scene uses the same geometry and states as the real field report. */
export function setJourneyField(states: string, passes: string[]) {
  observations = { states, passes };
  shownPass = -1;
  showPass(passes.length - 1);
  schedule();
}
function showPass(index: number) {
  if (!observations || index === shownPass || index < 0) return;
  shownPass = index;
  const state = observations.states[index] ?? "-";
  const label = ({ f: "Flooded", d: "Drained", u: "Uncertain", "-": "No observation" } as Record<string,string>)[state];
  const passElements = document.querySelectorAll("#pvPasses .pcol");
  const date = passElements[index]?.getAttribute("title")?.split(": ")[0] ?? observations.passes[index].slice(0,10);
  const caption = document.querySelector("#journeyAcquisition");
  if (caption) caption.textContent = `${date} · ${label}`;
  const polygon = document.querySelector<SVGElement>("#pvMap .hf");
  const color = ({ f:"#244fb6", d:"#bf4429", u:"#66738a", "-":"#66738a" } as Record<string,string>)[state];
  if (polygon) { polygon.style.fill = color; polygon.style.stroke = color; }
  passElements.forEach((pass,i) => pass.classList.toggle("is-observed", i === index));
}

function render() {
  scheduled = false;
  if (!opening || !journey || !visible) return;
  const paused = reduced.matches || document.documentElement.classList.contains("motion-paused");
  const height = innerHeight;
  if (instrument) {
    const navHeight = document.querySelector('nav[aria-label="Main"]')?.getBoundingClientRect().height ?? 88;
    journey.classList.toggle("is-tall", instrument.getBoundingClientRect().height > height - navHeight - 48);
  }
  const box = journey.getBoundingClientRect();
  const progress = clamp((height * .6 - box.top) / Math.max(1, box.height - height * .4));
  if (!paused) {
    opening.style.setProperty("--opening-progress", String(clamp(-opening.getBoundingClientRect().top / height)));
    journey.style.setProperty("--journey-progress", progress.toFixed(4));
    if (observations && box.top < height && box.bottom > 0 && innerWidth >= 1000) {
      const first = chapters[0]?.getBoundingClientRect().top ?? box.top;
      const last = chapters.at(-1)?.getBoundingClientRect().top ?? box.bottom;
      const seasonProgress = clamp((height * .55 - first) / Math.max(1,last-first));
      showPass(Math.min(observations.passes.length - 1, Math.floor(seasonProgress * observations.passes.length)));
    }
  }
  // Keep the stage meaningful even when animation is paused or unavailable.
  const active = chapters.reduce((picked, chapter, index) =>
    chapter.getBoundingClientRect().top <= height * .55 ? index : picked, 0);
  journey.dataset.chapter = String(active);
  if (stage) stage.textContent = ["Locate", "Observe", "Inspect"][active] ?? "Locate";
}
function schedule() {
  if (scheduled || !visible) return;
  scheduled = true;
  requestAnimationFrame(render);
}
addEventListener("scroll", schedule, { passive: true });
addEventListener("resize", schedule, { passive: true });
addEventListener("pageshow", schedule);
reduced.addEventListener("change", schedule);
new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
document.addEventListener("visibilitychange", () => {
  visible = !document.hidden;
  if (visible) schedule();
});
if (opening && journey) {
  new ResizeObserver(schedule).observe(journey);
  if (instrument) new ResizeObserver(schedule).observe(instrument);
  schedule();
}
