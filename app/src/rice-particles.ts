/** Decorative rice grains. Field measurements and model states are never drawn here. */
type Grain = {
  x: number;
  y: number;
  depth: number;
  phase: number;
  angle: number;
  length: number;
  opacity: number;
  tone: number;
  offsetX: number;
  offsetY: number;
};

for (const [canvasId, hostId] of [['riceParticles', 'opening'], ['brandRice', 'brandInterlude']]) {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  const host = document.getElementById(hostId);
  const context = canvas?.getContext('2d', { alpha: true });
  if (canvas && host && context) installRice(canvas, host, context);
}

function installRice(canvas: HTMLCanvasElement, host: HTMLElement, context: CanvasRenderingContext2D) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const tones = ['#e8f2ff', '#c2dbff', '#a4c4f2'];
  const pointer = { x: .5, y: .5, targetX: .5, targetY: .5, active: false, strength: 0 };
  let width = 1, height = 1, onScreen = false, request = 0, last = 0, elapsed = 0, paints = 0;
  let grains: Grain[] = [];
  const interval = 1000 / 30;

  function randomSource(seed: number) {
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function seedGrains() {
    const random = randomSource(canvas.id === 'brandRice' ? 271828 : 314159);
    const count = width <= 600 ? 36 : 88;
    grains = Array.from({ length: count }, () => {
      const edge = random() < .76;
      let x = random();
      let y = random();
      if (edge) x = random() < .5 ? random() * .28 : .72 + random() * .28;
      // Leave the centered headline and wordmark quieter than the margins.
      if (x > .28 && x < .72 && y > .2 && y < .73) y = random() < .5 ? y * .2 : .78 + random() * .22;
      const depth = .18 + random() * .82;
      return {
        x, y, depth, phase: random() * Math.PI * 2,
        angle: -.9 + random() * 1.8,
        length: 7 + depth * 13,
        opacity: .25 + depth * .45,
        tone: Math.floor(random() * tones.length),
        offsetX: 0, offsetY: 0,
      };
    });
    canvas.dataset.count = String(count);
  }

  function mode() {
    if (reduced.matches) return 'static';
    if (document.hidden) return 'hidden';
    return onScreen ? 'running' : 'offscreen';
  }

  function paint(delta = 0) {
    context.clearRect(0, 0, width, height);
    const time = elapsed / 1000;
    const damping = delta ? 1 - Math.exp(-delta / 150) : 0;
    const radius = Math.min(190, width * .25);
    const margin = 32;
    for (const grain of grains) {
      const rise = time * (3 + grain.depth * 8);
      const y = ((grain.y * height - rise + margin) % (height + margin * 2) + height + margin * 2) % (height + margin * 2) - margin;
      const x = grain.x * width + Math.sin(time * .23 + grain.phase) * (10 + grain.depth * 22)
        + Math.cos(time * .11 + grain.phase * 2) * 7;
      const dx = x - pointer.x * width, dy = y - pointer.y * height;
      const distance = Math.hypot(dx, dy);
      const influence = Math.max(0, 1 - distance / radius) ** 2 * pointer.strength;
      const push = influence * (24 + grain.depth * 36);
      const offsetX = dx / Math.max(1, distance) * push + (pointer.x - .5) * grain.depth * 12 * pointer.strength;
      const offsetY = dy / Math.max(1, distance) * push + (pointer.y - .5) * grain.depth * 8 * pointer.strength;
      grain.offsetX += (offsetX - grain.offsetX) * damping;
      grain.offsetY += (offsetY - grain.offsetY) * damping;
      const drawX = x + grain.offsetX, drawY = y + grain.offsetY;
      const centered = drawX > width * .26 && drawX < width * .74 && drawY > height * .2 && drawY < height * .74;
      const length = grain.length * (width <= 600 ? .82 : 1);
      const breadth = length * .2;

      context.save();
      context.translate(drawX, drawY);
      context.rotate(grain.angle + Math.sin(time * .31 + grain.phase) * .2);
      context.globalAlpha = grain.opacity * (centered ? .27 : 1);
      context.fillStyle = tones[grain.tone];
      // Two bowed sides meet at pointed ends: a rice grain, rather than a star or a dot.
      context.beginPath();
      context.moveTo(-length * .5, 0);
      context.bezierCurveTo(-length * .24, -breadth * .7, length * .25, -breadth * .55, length * .5, 0);
      context.bezierCurveTo(length * .2, breadth * .55, -length * .25, breadth * .62, -length * .5, 0);
      context.fill();
      if (grain.depth > .5) {
        context.globalAlpha *= .38;
        context.strokeStyle = '#3562a1';
        context.lineWidth = .55;
        context.beginPath();
        context.moveTo(-length * .31, 0);
        context.quadraticCurveTo(0, breadth * .13, length * .3, 0);
        context.stroke();
      }
      context.restore();
    }
    canvas.dataset.frame = String(++paints);
  }

  function tick(now: number) {
    request = 0;
    const currentMode = mode();
    if (currentMode !== 'running') { canvas.dataset.motion = currentMode; return; }
    if (!last) last = now - interval;
    const delta = now - last;
    if (delta >= interval - .5) {
      const step = Math.min(delta, 100);
      elapsed += step;
      last = now;
      const damping = 1 - Math.exp(-step / 180);
      pointer.x += (pointer.targetX - pointer.x) * damping;
      pointer.y += (pointer.targetY - pointer.y) * damping;
      pointer.strength += ((pointer.active ? 1 : 0) - pointer.strength) * damping;
      paint(step);
    }
    request = requestAnimationFrame(tick);
  }

  function update() {
    if (request) cancelAnimationFrame(request);
    request = 0;
    last = 0;
    canvas.dataset.motion = mode();
    if (mode() === 'running') request = requestAnimationFrame(tick);
  }

  function resize() {
    const box = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(box.width));
    const nextHeight = Math.max(1, Math.round(box.height));
    if (width === nextWidth && height === nextHeight && paints) return;
    width = nextWidth;
    height = nextHeight;
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    seedGrains();
    paint();
    update();
  }

  host.addEventListener('pointermove', event => {
    if (mode() !== 'running' || event.pointerType === 'touch') return;
    const box = canvas.getBoundingClientRect();
    pointer.targetX = Math.max(0, Math.min(1, (event.clientX - box.left) / width));
    pointer.targetY = Math.max(0, Math.min(1, (event.clientY - box.top) / height));
    pointer.active = true;
  }, { passive: true });
  host.addEventListener('pointerleave', () => { pointer.active = false; pointer.targetX = .5; pointer.targetY = .5; });
  new IntersectionObserver(entries => {
    onScreen = entries[0].isIntersecting && entries[0].intersectionRatio > 0;
    update();
  }, { threshold: 0 }).observe(canvas);
  new ResizeObserver(resize).observe(canvas);
  reduced.addEventListener('change', update);
  document.addEventListener('visibilitychange', update);
  resize();
}

export {};
