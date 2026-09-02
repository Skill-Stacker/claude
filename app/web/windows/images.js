// windows/images.js: "Make a Picture". Talks to /api/images/* (see the
// header comment in app/lib/studio/images.js for the full route list).
// Never call this "creative AI" or "art" in copy, per the audience
// research this app was built from; it makes a picture from words, said
// plainly. Follows the same DOM-building and host.api conventions as
// settings.js and chat.js: no framework, host.api.getJson/postJson/postSse,
// host.toast for one-line feedback, host.api.events for the shared bus.

const SIZES = [
  { value: '512x512', label: 'Small (512 by 512)' },
  { value: '768x768', label: 'Large (768 by 768, slower)' },
];

function injectStyles() {
  if (document.getElementById('stickos-images-style')) return;
  const style = document.createElement('style');
  style.id = 'stickos-images-style';
  style.textContent = `
    .images-body { display: flex; flex-direction: column; gap: 0.9rem; }
    .img-card { border: 1px solid rgba(255,255,255,0.12); border-radius: 0.6rem; padding: 0.8rem; }
    .img-card h4 { margin: 0 0 0.5rem; font-size: 0.85rem; opacity: 0.85; }
    .img-row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .img-field { display: flex; flex-direction: column; gap: 0.25rem; flex: 1 1 auto; min-width: 8rem; }
    .img-field label { font-size: 0.78rem; opacity: 0.8; }
    .img-field input[type="text"], .img-field input[type="number"], .img-field select, .img-field textarea {
      font: inherit; padding: 0.4rem 0.5rem; border-radius: 0.4rem;
      border: 1px solid rgba(255,255,255,0.18); background: rgba(0,0,0,0.15); color: inherit;
    }
    .img-field textarea { resize: vertical; min-height: 3.2rem; }
    .img-note { font-size: 0.78rem; opacity: 0.75; margin: 0.3rem 0 0; }
    .img-note.warn { color: #e8b04b; }
    .img-progress-track { height: 0.5rem; border-radius: 999px; background: rgba(255,255,255,0.1); overflow: hidden; margin-top: 0.5rem; }
    .img-progress-fill { height: 100%; width: 0%; background: currentColor; opacity: 0.7; transition: width 0.2s ease; }
    .img-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: 0.6rem; }
    .img-thumb { border: 1px solid rgba(255,255,255,0.1); border-radius: 0.5rem; overflow: hidden; background: rgba(255,255,255,0.03); }
    .img-thumb img { display: block; width: 100%; aspect-ratio: 1 / 1; object-fit: cover; background: rgba(0,0,0,0.2); }
    .img-thumb-meta { padding: 0.35rem 0.45rem; font-size: 0.72rem; opacity: 0.8; }
    .img-thumb-meta p { margin: 0; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .img-thumb-meta .img-thumb-time { opacity: 0.6; margin-top: 0.2rem; }
    .img-empty { opacity: 0.6; font-size: 0.82rem; }
  `;
  document.head.appendChild(style);
}

function fieldRow(labelText, inputEl) {
  const wrap = document.createElement('div');
  wrap.className = 'img-field';
  const label = document.createElement('label');
  label.textContent = labelText;
  const id = 'img-' + labelText.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  inputEl.id = id;
  label.setAttribute('for', id);
  wrap.append(label, inputEl);
  return wrap;
}

function formatSeconds(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return n < 10 ? n.toFixed(1) + ' seconds' : Math.round(n) + ' seconds';
}

function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function mount(host) {
  injectStyles();

  const win = host.createWindow({ id: 'images', title: 'Make a Picture', icon: 'P', width: 520, height: 640, left: 160, top: 80 });
  const body = win.body;
  body.classList.add('images-body');

  // -- setup card ---------------------------------------------------------
  const setupCard = document.createElement('div');
  setupCard.className = 'img-card';
  const setupHd = document.createElement('h4');
  setupHd.textContent = 'Set up';
  const setupNote = document.createElement('p');
  setupNote.className = 'img-note';
  const setupBtn = document.createElement('button');
  setupBtn.type = 'button';
  setupBtn.className = 'btn-primary';
  setupBtn.textContent = 'Download the picture maker';
  const setupProgressTrack = document.createElement('div');
  setupProgressTrack.className = 'img-progress-track';
  setupProgressTrack.hidden = true;
  const setupProgressFill = document.createElement('div');
  setupProgressFill.className = 'img-progress-fill';
  setupProgressTrack.appendChild(setupProgressFill);
  const setupDetail = document.createElement('p');
  setupDetail.className = 'img-note';

  const modelField = document.createElement('div');
  modelField.className = 'img-row';
  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.placeholder = "Path to a model file inside this stick's models folder";
  modelInput.style.flex = '1 1 auto';
  const modelBtn = document.createElement('button');
  modelBtn.type = 'button';
  modelBtn.className = 'btn-ghost';
  modelBtn.textContent = 'Use this model';
  modelField.append(modelInput, modelBtn);

  setupCard.append(setupHd, setupNote, setupBtn, setupProgressTrack, setupDetail, modelField);

  // -- make card ------------------------------------------------------------
  const makeCard = document.createElement('div');
  makeCard.className = 'img-card';
  makeCard.hidden = true;
  const makeHd = document.createElement('h4');
  makeHd.textContent = 'Make a picture';

  const promptInput = document.createElement('textarea');
  promptInput.placeholder = 'What should the picture show? (example: a red fox in the snow)';
  promptInput.setAttribute('aria-label', 'What the picture should show');
  const promptField = fieldRow('What the picture should show', promptInput);

  const negativeInput = document.createElement('textarea');
  negativeInput.placeholder = 'Anything to leave out (optional)';
  const negativeField = fieldRow('Things to leave out (optional)', negativeInput);

  const sizeSelect = document.createElement('select');
  for (const s of SIZES) {
    const opt = document.createElement('option');
    opt.value = s.value;
    opt.textContent = s.label;
    sizeSelect.appendChild(opt);
  }
  const sizeField = fieldRow('Size', sizeSelect);

  const stepsInput = document.createElement('input');
  stepsInput.type = 'number';
  stepsInput.min = '1';
  stepsInput.max = '50';
  stepsInput.value = '20';
  const stepsField = fieldRow('Quality steps (higher is slower)', stepsInput);

  const seedInput = document.createElement('input');
  seedInput.type = 'number';
  seedInput.placeholder = 'Leave blank for a surprise';
  const seedField = fieldRow('Seed (optional)', seedInput);

  const controlsRow = document.createElement('div');
  controlsRow.className = 'img-row';
  controlsRow.append(sizeField, stepsField, seedField);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'img-row';
  const generateBtn = document.createElement('button');
  generateBtn.type = 'button';
  generateBtn.className = 'btn-primary';
  generateBtn.textContent = 'Make it';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.hidden = true;
  actionsRow.append(generateBtn, cancelBtn);

  const genProgressTrack = document.createElement('div');
  genProgressTrack.className = 'img-progress-track';
  genProgressTrack.hidden = true;
  const genProgressFill = document.createElement('div');
  genProgressFill.className = 'img-progress-fill';
  genProgressTrack.appendChild(genProgressFill);
  const genNote = document.createElement('p');
  genNote.className = 'img-note';

  makeCard.append(makeHd, promptField, negativeField, controlsRow, actionsRow, genProgressTrack, genNote);

  // -- gallery --------------------------------------------------------------
  const galleryCard = document.createElement('div');
  galleryCard.className = 'img-card';
  const galleryHd = document.createElement('h4');
  galleryHd.textContent = 'What Scout has made';
  const galleryGrid = document.createElement('div');
  galleryGrid.className = 'img-gallery';
  galleryCard.append(galleryHd, galleryGrid);

  body.append(setupCard, makeCard, galleryCard);

  // -- state ----------------------------------------------------------------
  let currentStream = null;
  let elapsedTimer = null;
  let genStartedAt = 0;
  let removeImagesListener = null;

  function setGenBusy(busy) {
    generateBtn.disabled = busy;
    promptInput.disabled = busy;
    cancelBtn.hidden = !busy;
    genProgressTrack.hidden = !busy;
    if (busy) {
      genProgressFill.style.width = '30%';
      genStartedAt = Date.now();
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = setInterval(() => {
        genNote.textContent = 'Working on it, ' + Math.round((Date.now() - genStartedAt) / 1000) + ' seconds so far.';
      }, 500);
    } else if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function renderGallery(images) {
    galleryGrid.innerHTML = '';
    if (!images || !images.length) {
      const empty = document.createElement('p');
      empty.className = 'img-empty';
      empty.textContent = 'Nothing made yet.';
      galleryGrid.appendChild(empty);
      return;
    }
    for (const item of images) {
      const card = document.createElement('div');
      card.className = 'img-thumb';
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = item.prompt || 'a picture Scout made';
      img.loading = 'lazy';
      const meta = document.createElement('div');
      meta.className = 'img-thumb-meta';
      const p = document.createElement('p');
      p.textContent = item.prompt || '';
      p.title = item.prompt || '';
      const time = document.createElement('p');
      time.className = 'img-thumb-time';
      time.textContent = formatWhen(item.createdAt) + (typeof item.seconds === 'number' ? ' · ' + formatSeconds(item.seconds) : '');
      meta.append(p, time);
      card.append(img, meta);
      galleryGrid.appendChild(card);
    }
  }

  async function loadGallery() {
    try {
      const data = await host.api.getJson('/api/images/gallery');
      renderGallery(Array.isArray(data.images) ? data.images : []);
    } catch {
      renderGallery([]);
    }
  }

  function renderStatus(status) {
    if (!status) return;
    const binaryPresent = status.binary && status.binary.present;
    const modelPresent = status.model && status.model.present;

    setupBtn.hidden = binaryPresent;
    setupProgressTrack.hidden = true;
    setupNote.textContent = binaryPresent
      ? 'The picture maker is set up on this stick.'
      : 'Scout needs to download the picture-making engine once. This reaches github.com; see What Scout Just Did.';

    modelInput.value = (status.model && status.model.path) || modelInput.value;
    setupDetail.className = 'img-note' + (modelPresent ? '' : ' warn');
    setupDetail.textContent = modelPresent
      ? 'Model: ' + status.model.path
      : (status.model && status.model.note) || 'No picture model is pinned yet.';

    const ready = binaryPresent && modelPresent;
    makeCard.hidden = !ready;

    if (typeof status.lastGenerationSeconds === 'number' && !generateBtn.disabled) {
      genNote.textContent = 'Your last one took ' + formatSeconds(status.lastGenerationSeconds) + '.';
    }
  }

  async function loadStatus() {
    try {
      const status = await host.api.getJson('/api/images/status');
      renderStatus(status);
    } catch (err) {
      setupNote.textContent = 'Could not check the picture maker. ' + (err.message || '');
    }
  }

  setupBtn.addEventListener('click', async () => {
    setupBtn.disabled = true;
    setupProgressTrack.hidden = false;
    setupProgressFill.style.width = '2%';
    setupNote.textContent = 'Downloading the picture-making engine.';
    try {
      const status = await host.api.postJson('/api/images/setup', {});
      renderStatus(status);
      host.toast('The picture maker is ready.');
    } catch (err) {
      setupNote.textContent = 'Could not set that up. ' + (err.message || '');
    } finally {
      setupBtn.disabled = false;
      setupProgressTrack.hidden = true;
    }
  });

  modelBtn.addEventListener('click', async () => {
    const path = modelInput.value.trim();
    if (!path) return;
    modelBtn.disabled = true;
    try {
      const status = await host.api.postJson('/api/images/model', { path });
      renderStatus(status);
      host.toast('Model set.');
    } catch (err) {
      host.toast('Could not use that model. ' + (err.message || ''), { kind: 'error' });
    } finally {
      modelBtn.disabled = false;
    }
  });

  generateBtn.addEventListener('click', () => {
    const prompt = promptInput.value.trim();
    if (!prompt) {
      host.toast('Tell Scout what picture to make first.', { kind: 'error' });
      return;
    }
    setGenBusy(true);
    genNote.textContent = 'Getting started.';
    const seedRaw = seedInput.value.trim();

    currentStream = host.api.postSse(
      '/api/images/generate',
      {
        prompt,
        negative: negativeInput.value.trim(),
        size: sizeSelect.value,
        steps: Number(stepsInput.value) || 20,
        seed: seedRaw === '' ? undefined : Number(seedRaw),
      },
      {
        progress(data) {
          const phase = data && data.phase;
          if (phase === 'starting') {
            genNote.textContent = 'Starting the picture maker.';
            genProgressFill.style.width = '20%';
          } else if (phase === 'queued') {
            genNote.textContent = 'In line.';
            genProgressFill.style.width = '35%';
          } else if (phase === 'generating') {
            genNote.textContent = 'Painting, ' + Math.round((Date.now() - genStartedAt) / 1000) + ' seconds so far.';
            genProgressFill.style.width = '75%';
          } else if (phase === 'completed') {
            genProgressFill.style.width = '95%';
          }
        },
        done(data) {
          genProgressFill.style.width = '100%';
          genNote.textContent = 'Done, took ' + formatSeconds(data.seconds) + '.';
          setGenBusy(false);
          promptInput.value = '';
          loadGallery();
        },
        error(data) {
          genNote.textContent = (data && data.message) || 'Could not make that picture.';
          setGenBusy(false);
        },
        onerror(err) {
          genNote.textContent = 'Lost the connection. ' + ((err && err.message) || '');
          setGenBusy(false);
        },
      },
    );
  });

  cancelBtn.addEventListener('click', async () => {
    try {
      await host.api.postJson('/api/images/cancel', {});
    } catch {
      // best effort
    }
    if (currentStream) currentStream.abort();
    genNote.textContent = 'Cancelled.';
    setGenBusy(false);
  });

  const originalOpen = win.open;
  win.open = function open() {
    originalOpen();
    loadStatus();
    loadGallery();
    if (!removeImagesListener) {
      removeImagesListener = host.api.events.on('images', (event) => {
        if (!win.isOpen()) return;
        if (event && event.phase === 'downloading' && typeof event.percent === 'number') {
          setupProgressTrack.hidden = false;
          setupProgressFill.style.width = Math.round(event.percent * 100) + '%';
        } else if (event && (event.phase === 'ready' || event.phase === 'already_present')) {
          loadStatus();
        }
      });
    }
  };

  return win;
}
