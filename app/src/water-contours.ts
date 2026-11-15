/** Original water-surface contours. Decorative only; no model or map data is drawn here. */
const canvas = document.querySelector<HTMLCanvasElement>("#waterContours");
const hero = document.querySelector<HTMLElement>("#opening");

if (canvas && hero) {
  const context = canvas.getContext("2d", { alpha: true });
  if (context) installWater(canvas, hero, context);
}

function installWater(canvas: HTMLCanvasElement, hero: HTMLElement, ctx: CanvasRenderingContext2D) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let width = 1, height = 1, columns = 1, rows = 1;
  let samples = new Float32Array(4);
  let frame = 0, drawn = 0, previous = 0, elapsed = 0;
  let onScreen = false;
  const pointer = { x: .3, y: .55, targetX: .3, targetY: .55 };
  const STEP = 1000 / 30;
  // Marching-square edges, clockwise from the upper edge. Ambiguous cells split into two paths.
  const segments: readonly (readonly number[])[] = [
    [], [3, 0], [0, 1], [3, 1], [1, 2], [3, 0, 1, 2], [0, 2], [3, 2],
    [2, 3], [0, 2], [0, 1, 2, 3], [1, 2], [1, 3], [0, 1], [0, 3], [],
  ];

  function paused() {
    return reduced.matches || document.hidden || !onScreen || document.documentElement.classList.contains("motion-paused");
  }

  function draw() {
    const t = elapsed * .00022;
    ctx.clearRect(0, 0, width, height);
    const atmosphere = ctx.createLinearGradient(0, 0, width * .3, height);
    atmosphere.addColorStop(0, "#0b204b");
    atmosphere.addColorStop(.58, "#204a9a");
    atmosphere.addColorStop(1, "#5e87c9");
    ctx.fillStyle = atmosphere;
    ctx.fillRect(0, 0, width, height);

    const glowX = width * (.24 + Math.sin(t * .3) * .06);
    const glowY = height * (.64 + Math.cos(t * .4) * .08);
    const glow = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, width * .58);
    glow.addColorStop(0, "#a9cdff70");
    glow.addColorStop(.4, "#78a5ee30");
    glow.addColorStop(1, "#78a5ee00");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    const stride = columns + 1;
    const aspect = width / height;
    for (let y = 0; y <= rows; y++) {
      const ny = y / rows;
      for (let x = 0; x <= columns; x++) {
        const nx = x / columns;
        const px = (nx - pointer.x) * Math.min(aspect, 1.8);
        const py = ny - pointer.y;
        const distance = Math.sqrt(px * px + py * py);
        // Slow broad channels and crossing ripples produce changing pools rather than drifting wallpaper.
        samples[y * stride + x] =
          Math.sin(nx * 8.5 + Math.sin(ny * 5.2 - t * .65) * 1.3 + t * .45) * .95 +
          Math.cos(ny * 8.2 - nx * 2.4 + Math.sin(t * .32) * .7) * .8 +
          Math.sin((nx + ny) * 13 - t * 1.2) * .18 +
          Math.sin(distance * 25 - t * 2.2) * Math.exp(-distance * distance * 8) * .52;
      }
    }

    const dx = width / columns, dy = height / rows;
    for (let levelIndex = 0; levelIndex < 27; levelIndex++) {
      const level = -2.15 + levelIndex * .165;
      const stroke = ctx.createLinearGradient(0, 0, width, height * .25);
      const strong = levelIndex % 5 === 0;
      stroke.addColorStop(0, strong ? "#c7e0ff7a" : "#b7d6ff40");
      stroke.addColorStop(.48, strong ? "#c7e0ff66" : "#b7d6ff32");
      stroke.addColorStop(1, strong ? "#aacfff40" : "#aacfff20");
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strong ? 1.15 : .75;
      ctx.beginPath();
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < columns; x++) {
          const offset = y * stride + x;
          const a = samples[offset], b = samples[offset + 1];
          const c = samples[offset + stride + 1], d = samples[offset + stride];
          const code = (a > level ? 1 : 0) | (b > level ? 2 : 0) | (c > level ? 4 : 0) | (d > level ? 8 : 0);
          const edges = segments[code];
          if (!edges.length) continue;
          const left = x * dx, top = y * dy;
          const fraction = (v1: number, v2: number) => (level - v1) / (v2 - v1 || .00001);
          const point = (edge: number): [number, number] => {
            if (edge === 0) return [left + fraction(a, b) * dx, top];
            if (edge === 1) return [left + dx, top + fraction(b, c) * dy];
            if (edge === 2) return [left + fraction(d, c) * dx, top + dy];
            return [left, top + fraction(a, d) * dy];
          };
          for (let i = 0; i < edges.length; i += 2) {
            const start = point(edges[i]), end = point(edges[i + 1]);
            ctx.moveTo(start[0], start[1]);
            ctx.lineTo(end[0], end[1]);
          }
        }
      }
      ctx.stroke();
    }
    // A stable observable hook for real browser tests; it counts actual paints, not RAF callbacks.
    canvas.dataset.frame = String(++drawn);
  }

  function tick(now: number) {
    frame = 0;
    if (paused()) return;
    if (!previous) previous = now - STEP;
    const delta = now - previous;
    if (delta >= STEP - .5) {
      elapsed += Math.min(delta, 100);
      previous = now;
      pointer.x += (pointer.targetX - pointer.x) * .06;
      pointer.y += (pointer.targetY - pointer.y) * .06;
      draw();
    }
    frame = requestAnimationFrame(tick);
  }

  function update() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previous = 0;
    if (paused()) {
      canvas.dataset.motion = reduced.matches ? "static" : onScreen && !document.hidden ? "paused" : "offscreen";
      return;
    }
    canvas.dataset.motion = "running";
    frame = requestAnimationFrame(tick);
  }

  function resize() {
    const box = hero.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(box.width));
    const nextHeight = Math.max(1, Math.round(box.height));
    if (width === nextWidth && height === nextHeight && drawn) return;
    width = nextWidth;
    height = nextHeight;
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    columns = Math.min(96, Math.max(24, Math.ceil(width / 20)));
    rows = Math.min(60, Math.max(24, Math.ceil(height / 20)));
    samples = new Float32Array((columns + 1) * (rows + 1));
    draw();
    update();
  }

  hero.addEventListener("pointermove", event => {
    if (paused() || event.pointerType === "touch") return;
    const box = hero.getBoundingClientRect();
    pointer.targetX = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    pointer.targetY = Math.max(0, Math.min(1, (event.clientY - box.top) / box.height));
  }, { passive: true });
  hero.addEventListener("pointerleave", () => { pointer.targetX = .3; pointer.targetY = .55; });
  new IntersectionObserver(entries => {
    onScreen = entries[0].isIntersecting;
    update();
  }, { threshold: 0 }).observe(hero);
  new ResizeObserver(resize).observe(hero);
  new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  reduced.addEventListener("change", update);
  document.addEventListener("visibilitychange", update);
  resize();
}

export {};
