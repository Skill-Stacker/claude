// The lamp: a full-viewport canvas visualizer that sits behind the
// blurred-glass panels, drawing a Bernoulli lemniscate (an infinity shape)
// anchored to the mic button. Four moods: idle (slow amber dust), listening
// (a blue wobble that follows the mic level), thinking (three comets
// orbiting the curve), speaking (spectrum spikes off a live AnalyserNode).
//
// Ported from Scout's original lamp for the web build, with the rules that
// bit on the real rig: static shapes draw with source-over, only the moving
// glows use 'lighter'; the CSS backdrop-filter blur belongs to the panels,
// this canvas only ever repaints the particle layer; prefers-reduced-motion
// gets a calm static glow, no animation; a hidden or covered tab still gets
// drawn to, just at 10 fps instead of via requestAnimationFrame; particle
// counts scale down on a slow machine and back up once frames are cheap
// again.
//
// initLamp() is the only thing that touches window/document/canvas, so this
// file imports cleanly under Node with nothing at module load time reaching
// for a browser global. The self-attach block at the bottom is guarded the
// same way, and polls briefly for window.StickOS since app.js and this
// module load independently.

const MOOD_COLORS = {
  idle: { r: 255, g: 178, b: 84 }, // amber dust
  listening: { r: 96, g: 170, b: 255 }, // blue wobble
  thinking: { r: 210, g: 198, b: 255 }, // pale lavender comets
  speaking: { r: 120, g: 230, b: 200 }, // cool teal spikes
};

const SLOW_FRAME_MS = 24;
const HIDDEN_FPS = 10;
const TRAIL_LEN = 8;
const MIN_PARTICLE_SCALE = 0.2;

// Bernoulli lemniscate: x = a cos t / (1 + sin^2 t), y = a sin t cos t / (1 + sin^2 t)
function lemniscatePoint(t, a) {
  const s = Math.sin(t);
  const c = Math.cos(t);
  const denom = 1 + s * s;
  return { x: (a * c) / denom, y: (a * s * c) / denom };
}

export function initLamp({ canvas, anchorEl }) {
  const ctx = canvas.getContext('2d');

  let mood = 'idle';
  let level = 0; // 0..1, fed by voice.js while listening
  let analyser = null;
  let freqData = null;
  let destroyed = false;
  let dpr = window.devicePixelRatio || 1;
  let width = 0;
  let height = 0; // CSS pixels
  let timeAccum = 0;
  let budgetScale = 1;

  let reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function onMotionChange(event) {
    reducedMotion = event.matches;
    if (reducedMotion) {
      stopLoop();
      drawStatic();
    } else {
      startLoop();
    }
  }
  if (motionQuery) {
    if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotionChange);
    else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);
  }

  // -- particle pools --------------------------------------------------

  const IDLE_COUNT = 40;
  const idleParticles = [];
  for (let i = 0; i < IDLE_COUNT; i++) {
    idleParticles.push({
      t: Math.random() * Math.PI * 2,
      speed: 0.05 + Math.random() * 0.05,
      size: 1 + Math.random() * 1.5,
      phase: Math.random() * Math.PI * 2,
    });
  }

  const thinkingComets = [];
  for (let i = 0; i < 3; i++) {
    thinkingComets.push({ t: (i / 3) * Math.PI * 2, speed: 0.9 + i * 0.15, trail: [] });
  }

  // -- sizing ------------------------------------------------------------

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    width = rect.width || window.innerWidth;
    height = rect.height || window.innerHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  function anchorCenter() {
    if (anchorEl && typeof anchorEl.getBoundingClientRect === 'function') {
      const r = anchorEl.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, size: Math.max(r.width, r.height) };
      }
    }
    return { x: width / 2, y: height * 0.82, size: 64 };
  }

  function colorFor(m) {
    return MOOD_COLORS[m] || MOOD_COLORS.idle;
  }

  // -- drawing primitives --------------------------------------------------

  function drawStaticCurve(cx, cy, a, color, alpha) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const steps = 120;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const p = lemniscatePoint(t, a);
      const x = cx + p.x;
      const y = cy + p.y;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function glowDot(x, y, r, color, alpha) {
    if (r <= 0 || alpha <= 0) return;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`);
    gradient.addColorStop(1, `rgba(${color.r}, ${color.g}, ${color.b}, 0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // -- moods --------------------------------------------------------------

  function drawIdle(cx, cy, a, color, dt) {
    const active = Math.max(6, Math.round(idleParticles.length * budgetScale));
    for (let i = 0; i < active; i++) {
      const particle = idleParticles[i];
      particle.t += particle.speed * dt * 0.4;
      particle.phase += dt;
      const p = lemniscatePoint(particle.t, a);
      const pulse = 0.5 + 0.5 * Math.sin(particle.phase * 1.3);
      glowDot(cx + p.x, cy + p.y, particle.size + pulse * 1.5, color, 0.25 + pulse * 0.35);
    }
  }

  function drawListening(cx, cy, a, color, dt) {
    timeAccum += dt;
    const wobbleAmt = 0.15 + level * 0.5;
    const steps = Math.max(24, Math.round(90 * budgetScale));

    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const wobble = 1 + wobbleAmt * Math.sin(t * 5 + timeAccum * 3);
      const p = lemniscatePoint(t, a * wobble);
      const x = cx + p.x;
      const y = cy + p.y;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${0.3 + level * 0.5})`;
    ctx.lineWidth = 2 + level * 3;
    ctx.stroke();

    const dots = Math.max(4, Math.round(10 * budgetScale));
    for (let i = 0; i < dots; i++) {
      const t = (i / dots) * Math.PI * 2 + timeAccum * 1.5;
      const wobble = 1 + wobbleAmt * Math.sin(t * 5 + timeAccum * 3);
      const p = lemniscatePoint(t, a * wobble);
      glowDot(cx + p.x, cy + p.y, 4 + level * 6, color, 0.5 + level * 0.4);
    }
  }

  function drawThinking(cx, cy, a, color, dt) {
    for (const comet of thinkingComets) {
      comet.t += comet.speed * dt;
      comet.trail.push(comet.t);
      if (comet.trail.length > TRAIL_LEN) comet.trail.shift();
      for (let j = 0; j < comet.trail.length; j++) {
        const alpha = ((j + 1) / comet.trail.length) * 0.85;
        const p = lemniscatePoint(comet.trail[j], a);
        glowDot(cx + p.x, cy + p.y, 3 + alpha * 5, color, alpha * 0.8);
      }
    }
  }

  function drawSpeaking(cx, cy, a, color, dt) {
    timeAccum += dt;
    let bins = null;
    if (analyser && freqData) {
      analyser.getByteFrequencyData(freqData);
      bins = freqData;
    }
    const count = Math.max(12, Math.round(48 * budgetScale));
    for (let i = 0; i < count; i++) {
      const t = (i / count) * Math.PI * 2;
      const p = lemniscatePoint(t, a);
      const x = cx + p.x;
      const y = cy + p.y;
      let mag;
      if (bins) {
        const idx = Math.floor((i / count) * bins.length);
        mag = bins[idx] / 255;
      } else {
        mag = 0.2 + 0.15 * Math.sin(timeAccum * 6 + i); // no analyser attached yet: a gentle placeholder pulse
      }
      const dist = Math.hypot(x - cx, y - cy) || 1;
      const nx = (x - cx) / dist;
      const ny = (y - cy) / dist;
      const len = 6 + mag * 34;
      ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${0.25 + mag * 0.6})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + nx * len, y + ny * len);
      ctx.stroke();
    }
  }

  function adaptParticleBudget(frameMs) {
    if (frameMs > SLOW_FRAME_MS) {
      budgetScale = Math.max(MIN_PARTICLE_SCALE, budgetScale * 0.85);
    } else if (frameMs < SLOW_FRAME_MS * 0.5 && budgetScale < 1) {
      budgetScale = Math.min(1, budgetScale * 1.03);
    }
  }

  // -- static (reduced motion) render -------------------------------------

  function drawStatic() {
    if (destroyed) return;
    const { x: cx, y: cy, size: anchorSize } = anchorCenter();
    const a = Math.max(40, anchorSize * 1.6);
    const color = colorFor(mood);
    ctx.clearRect(0, 0, width, height);
    drawStaticCurve(cx, cy, a, color, 0.22);
    ctx.globalCompositeOperation = 'lighter';
    glowDot(cx, cy, a * 0.5, color, 0.35);
    ctx.globalCompositeOperation = 'source-over';
  }

  // -- animation loop -------------------------------------------------------

  let lastTime = performance.now();
  let rafHandle = null;
  let timeoutHandle = null;

  function scheduleNext() {
    if (destroyed || reducedMotion) return;
    if (typeof document !== 'undefined' && document.hidden) {
      timeoutHandle = setTimeout(() => frame(performance.now()), 1000 / HIDDEN_FPS);
    } else {
      rafHandle = requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    if (destroyed || reducedMotion) return;
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    const frameStart = performance.now();

    ctx.clearRect(0, 0, width, height);
    const { x: cx, y: cy, size: anchorSize } = anchorCenter();
    const a = Math.max(40, anchorSize * 1.6);
    const color = colorFor(mood);

    drawStaticCurve(cx, cy, a, color, mood === 'idle' ? 0.1 : 0.16);

    ctx.globalCompositeOperation = 'lighter';
    if (mood === 'listening') drawListening(cx, cy, a, color, dt);
    else if (mood === 'thinking') drawThinking(cx, cy, a, color, dt);
    else if (mood === 'speaking') drawSpeaking(cx, cy, a, color, dt);
    else drawIdle(cx, cy, a, color, dt);
    ctx.globalCompositeOperation = 'source-over';

    adaptParticleBudget(performance.now() - frameStart);
    scheduleNext();
  }

  function stopLoop() {
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }

  function startLoop() {
    stopLoop();
    if (reducedMotion) {
      drawStatic();
      return;
    }
    lastTime = performance.now();
    scheduleNext();
  }

  // -- public API -----------------------------------------------------------

  function setMood(next) {
    if (!MOOD_COLORS[next]) return;
    mood = next;
    if (reducedMotion) drawStatic();
  }

  function setLevel(v) {
    level = Math.max(0, Math.min(1, v || 0));
  }

  function attachAnalyser(node) {
    analyser = node || null;
    freqData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  }

  function destroy() {
    destroyed = true;
    stopLoop();
    window.removeEventListener('resize', resize);
    if (motionQuery) {
      if (motionQuery.removeEventListener) motionQuery.removeEventListener('change', onMotionChange);
      else if (motionQuery.removeListener) motionQuery.removeListener(onMotionChange);
    }
  }

  startLoop();

  return { setMood, setLevel, attachAnalyser, destroy };
}

// ---------------------------------------------------------------------------
// Self-attach: find window.StickOS (app.js may still be loading), find the
// lamp canvas and the mic button to anchor to, and wire up. Never throws
// when window/StickOS/the canvas are missing; it just gives up quietly,
// same as every other degrade path in this build.
// ---------------------------------------------------------------------------

function whenStickOS(callback) {
  if (typeof window === 'undefined') return;
  if (window.StickOS) {
    callback(window.StickOS);
    return;
  }
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (window.StickOS) {
      clearInterval(timer);
      callback(window.StickOS);
    } else if (attempts > 200) {
      clearInterval(timer); // ~10s at 50ms: app.js is not coming, give up quietly
    }
  }, 50);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  whenStickOS((StickOS) => {
    function attach() {
      const canvas = document.getElementById('lamp');
      if (!canvas) return; // page is not in the shape we expect; nothing to draw on
      const anchorEl = document.getElementById('mic');
      const lamp = initLamp({ canvas, anchorEl });
      StickOS.lamp = lamp;

      // app.js's own setMood emits on its internal bus; prefer listening on
      // that so other windows that also react to mood keep working. Only
      // wire setMood directly if nothing has defined it yet.
      if (StickOS.bus && typeof StickOS.bus.on === 'function') {
        StickOS.bus.on('mood', (mood) => lamp.setMood(mood));
      }
      if (typeof StickOS.setMood !== 'function') {
        StickOS.setMood = lamp.setMood;
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attach, { once: true });
    } else {
      attach();
    }
  });
}
