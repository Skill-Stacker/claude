// windows/boot.js: the boot overlay. Not a draggable window, it owns the
// static #boot markup in index.html and fades it out once the engine is
// ready. If /api/firstrun answers 404 (the downloads module is not wired in
// yet at this milestone) it skips straight to the desktop, per API.md's
// note that the server runs fine without that module during early work.

const GIGABYTE = 1000 * 1000 * 1000;

function formatGB(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null;
  return (bytes / GIGABYTE).toFixed(1);
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  const mb = bytesPerSec / (1000 * 1000);
  if (mb >= 1) return mb.toFixed(1) + ' MB/s';
  const kb = bytesPerSec / 1000;
  return Math.max(1, Math.round(kb)) + ' KB/s';
}

const STEP_STATE_LABEL = {
  pending: 'waiting',
  active: 'downloading',
  done: 'done',
  failed: 'could not finish',
  skipped: 'already on this stick',
};

const ENGINE_GUIDANCE = {
  spawn_enoent:
    'The engine could not start. Security software on this computer (like Windows Defender) sometimes blocks a new program the first time. Look for a notice from it, allow Scout, then try again.',
  silent:
    'Windows may be asking your permission, look for a window that popped up, maybe behind this one.',
  crashed: 'The engine stopped unexpectedly.',
  failed: 'The engine could not start.',
};

export function run(host, { bootEl, onDone }) {
  const sub = bootEl.querySelector('#bootSub');
  const log = bootEl.querySelector('#bootLog');
  const steps = bootEl.querySelector('#bootSteps');
  const note = bootEl.querySelector('#bootNote');
  const retryBtn = bootEl.querySelector('#bootRetryBtn');

  let done = false;
  let lastReceived = new Map(); // step id -> { bytes, at }
  let gpuKnown = null;

  function finish() {
    if (done) return;
    done = true;
    onDone();
  }

  function setNote(text) {
    if (!text) {
      note.hidden = true;
      note.textContent = '';
      return;
    }
    note.hidden = false;
    note.textContent = text;
  }

  function gpuLine(gpu) {
    if (!gpu || typeof gpu.available !== 'boolean') return null;
    gpuKnown = gpu;
    return gpu.available ? 'Using your graphics card.' : 'Using your processor.';
  }

  function renderSteps(list) {
    steps.innerHTML = '';
    if (!Array.isArray(list) || !list.length) return;
    const now = Date.now();
    for (const step of list) {
      const row = document.createElement('div');
      row.className = 'boot-step boot-step-' + (step.state || 'pending');

      const head = document.createElement('div');
      head.className = 'boot-step-head';
      const label = document.createElement('span');
      label.textContent = step.label || step.id || 'step';
      const state = document.createElement('span');
      state.className = 'boot-step-state';
      state.textContent = STEP_STATE_LABEL[step.state] || step.state || '';
      head.append(label, state);

      const track = document.createElement('div');
      track.className = 'boot-step-track';
      const fill = document.createElement('div');
      fill.className = 'boot-step-fill';
      const percent = typeof step.percent === 'number' ? Math.max(0, Math.min(100, step.percent)) : step.state === 'done' ? 100 : 0;
      fill.style.width = percent + '%';
      track.appendChild(fill);

      const detail = document.createElement('div');
      detail.className = 'boot-step-detail';
      const parts = [];
      if (typeof step.received === 'number' && typeof step.total === 'number' && step.total > 0) {
        parts.push(formatGB(step.received) + ' of ' + formatGB(step.total) + ' GB');
        const prior = lastReceived.get(step.id);
        if (prior && step.state === 'active') {
          const dt = (now - prior.at) / 1000;
          if (dt > 0.3) {
            const speed = formatSpeed((step.received - prior.bytes) / dt);
            if (speed) parts.push(speed);
          }
        }
        lastReceived.set(step.id, { bytes: step.received, at: now });
      }
      if (step.message) parts.push(step.message);
      detail.textContent = parts.join(', ');

      row.append(head, track, detail);
      steps.appendChild(row);
    }
  }

  function renderFirstrun(data) {
    if (!data) return;
    const phase = data.phase;
    retryBtn.hidden = true;

    if (phase === 'preflight') {
      sub.textContent = 'Checking this stick';
      log.textContent = 'Making sure there is room for everything Scout needs.';
      renderSteps([]);
      const free = formatGB(data.free);
      const needed = formatGB(data.needed);
      setNote(free != null && needed != null ? 'This stick has ' + free + ' GB free. Scout needs about ' + needed + ' GB.' : null);
    } else if (phase === 'blocked') {
      sub.textContent = 'Not enough room';
      log.textContent = 'There is not enough free space to finish setting up.';
      renderSteps(data.steps);
      const free = formatGB(data.free);
      const needed = formatGB(data.needed);
      setNote(
        free != null && needed != null
          ? 'This stick has ' + free + ' GB free, and Scout needs about ' + needed + ' GB. Free up some space, then try again.'
          : data.message || 'There is not enough free space to continue.',
      );
      retryBtn.hidden = false;
    } else if (phase === 'downloading') {
      sub.textContent = 'Getting everything Scout needs';
      log.textContent = 'The first run downloads about 5 gigabytes. This only happens once.';
      renderSteps(data.steps);
      const line = gpuLine(data.gpu);
      setNote(line);
    } else if (phase === 'verifying') {
      sub.textContent = 'Double-checking the download';
      log.textContent = "This may take a few minutes the first time while your security software checks the new files, that's normal.";
      renderSteps(data.steps);
    } else if (phase === 'probing') {
      sub.textContent = 'Checking your hardware';
      log.textContent = 'Looking for a graphics card to speed things up.';
      renderSteps(data.steps);
      setNote(gpuLine(data.gpu) || data.message);
    } else if (phase === 'starting') {
      sub.textContent = 'Starting the engine';
      log.textContent = 'Starting the engine, this can take up to a minute the first time.';
      renderSteps(data.steps);
      const line = gpuLine(data.gpu) || data.message;
      if (line) setNote(line);
    } else if (phase === 'ready') {
      sub.textContent = 'Ready';
      log.textContent = 'Scout is ready.';
      renderSteps(data.steps);
      // The 'engine' SSE channel (see renderEngine below) is what normally
      // fades this overlay out; this is a redundant, idempotent safety net
      // in case that specific event was ever missed.
      finish();
    } else if (phase === 'failed') {
      const failedStep = Array.isArray(data.steps) ? data.steps.find((s) => s.state === 'failed') : null;
      sub.textContent = 'Something went wrong';
      log.textContent = failedStep
        ? (failedStep.label || failedStep.id) + ' could not finish. ' + (data.message || '')
        : data.message || 'Something went wrong getting Scout ready.';
      renderSteps(data.steps);
      retryBtn.hidden = false;
    } else {
      sub.textContent = data.message || 'Getting ready';
    }
  }

  function renderEngine(data) {
    if (!data) return;
    const line = gpuLine(data.gpu);
    switch (data.state) {
      case 'starting':
        sub.textContent = 'Starting the engine';
        log.textContent = "Starting Scout's local engine.";
        retryBtn.hidden = true;
        break;
      case 'loading':
        sub.textContent = 'Loading the model';
        log.textContent = 'Loading the model into memory.';
        if (line) setNote(line);
        retryBtn.hidden = true;
        break;
      case 'ready':
        sub.textContent = 'Ready';
        log.textContent = 'Scout is ready.';
        finish();
        break;
      case 'spawn_enoent':
        sub.textContent = "Scout couldn't start the engine";
        log.textContent = data.guidance || ENGINE_GUIDANCE.spawn_enoent;
        retryBtn.hidden = false;
        break;
      case 'silent':
        sub.textContent = 'Waiting on a permission';
        log.textContent = data.guidance || ENGINE_GUIDANCE.silent;
        retryBtn.hidden = false;
        break;
      case 'crashed':
      case 'failed':
        sub.textContent = 'Something went wrong';
        log.textContent = data.guidance || ENGINE_GUIDANCE[data.state] || 'The engine stopped.';
        retryBtn.hidden = false;
        break;
      case 'stopped':
        sub.textContent = 'Stopped';
        log.textContent = 'The engine stopped.';
        break;
      default:
        break;
    }
  }

  retryBtn.addEventListener('click', async () => {
    retryBtn.disabled = true;
    log.textContent = 'Trying again.';
    try {
      const data = await host.api.postJson('/api/firstrun/retry', {});
      renderFirstrun(data);
    } catch (err) {
      log.textContent = 'Still could not start. ' + (err && err.message ? err.message : '');
    } finally {
      retryBtn.disabled = false;
    }
  });

  (async () => {
    let initial;
    try {
      initial = await host.api.getJson('/api/firstrun');
    } catch (err) {
      if (err && err.status === 404) {
        finish();
        return;
      }
      console.warn('Scout: /api/firstrun did not answer, skipping the boot overlay', err);
      finish();
      return;
    }

    renderFirstrun(initial);
    host.api.events.on('firstrun', renderFirstrun);
    host.api.events.on('engine', renderEngine);

    if (initial.phase === 'preflight') {
      try {
        const started = await host.api.postJson('/api/firstrun/start', {});
        renderFirstrun(started);
      } catch (err) {
        console.warn('Scout: could not start downloads', err);
      }
    }
  })();
}
