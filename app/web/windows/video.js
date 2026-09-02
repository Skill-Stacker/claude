// windows/video.js: Studio's video tools window. A setup card the first
// time (ffmpeg is a one-time ~120 MB download), a shared file picker, one
// card per tool, and a job list driven by SSE 'video' events. See
// app/lib/studio/video.js for the routes this drives. Plain words: no
// filter names, no codec talk, no ffmpeg jargon anywhere in this file's
// visible text.

const TOOL_LABEL = {
  trim: 'Trim',
  join: 'Join',
  captions: 'Captions',
  silence: 'Cut the quiet parts',
  shorts: 'Vertical export',
  setup: 'Setting up video tools',
};

const TERMINAL_PHASES = new Set(['done', 'failed', 'cancelled']);

function formatMB(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  return (bytes / (1000 * 1000)).toFixed(1) + ' MB';
}

function describeThreshold(db) {
  if (db <= -45) return 'Only cuts near-total silence.';
  if (db >= -25) return 'Cuts anything fairly quiet.';
  return 'Cuts ordinary pauses.';
}

function progressRow() {
  const track = document.createElement('div');
  track.className = 'boot-step-track';
  const fill = document.createElement('div');
  fill.className = 'boot-step-fill';
  fill.style.width = '0%';
  track.appendChild(fill);
  return { track, fill };
}

export function mount(host) {
  const win = host.createWindow({ id: 'video', title: 'Video', icon: 'P', width: 560, height: 680, left: 200, top: 80 });
  const body = win.body;
  body.classList.add('video-body');

  let setupJobId = null;
  let jobsById = new Map();

  // -- setup card -----------------------------------------------------------
  const setupCard = document.createElement('div');
  setupCard.className = 'video-setup';
  const setupNote = document.createElement('p');
  setupNote.className = 'settings-note';
  setupNote.textContent = "Video tools are not set up yet. They download once (about 120 MB) and then work offline.";
  const setupBtn = document.createElement('button');
  setupBtn.type = 'button';
  setupBtn.className = 'btn-primary';
  setupBtn.textContent = 'Set up video tools';
  const setupProgress = progressRow();
  setupProgress.track.hidden = true;
  setupCard.append(setupNote, setupBtn, setupProgress.track);

  const readyNote = document.createElement('p');
  readyNote.className = 'settings-note';
  readyNote.textContent = 'Video tools are ready.';
  readyNote.hidden = true;

  // -- file picker ------------------------------------------------------
  const fileHd = document.createElement('h4');
  fileHd.textContent = 'Pick a video';
  const fileRow = document.createElement('div');
  fileRow.className = 'video-field-row';
  const fileInput = document.createElement('input');
  fileInput.type = 'text';
  fileInput.placeholder = 'A file name from the list below, or a full path on this computer';
  fileInput.setAttribute('aria-label', 'Video file path');
  const refreshFilesBtn = document.createElement('button');
  refreshFilesBtn.type = 'button';
  refreshFilesBtn.className = 'btn-ghost';
  refreshFilesBtn.textContent = 'Refresh list';
  const checkBtn = document.createElement('button');
  checkBtn.type = 'button';
  checkBtn.className = 'btn-ghost';
  checkBtn.textContent = 'Check this file';
  fileRow.append(fileInput, checkBtn, refreshFilesBtn);
  const fileInfo = document.createElement('p');
  fileInfo.className = 'settings-note';
  const filesList = document.createElement('ul');
  filesList.className = 'contacts-list video-files-list';

  const toolsSection = document.createElement('div');
  toolsSection.className = 'video-tools';
  toolsSection.hidden = true;

  function requireFile() {
    const f = fileInput.value.trim();
    if (!f) {
      host.toast('Pick a video first.', { kind: 'error' });
      return null;
    }
    return f;
  }

  // -- trim -------------------------------------------------------------
  const trimCard = document.createElement('div');
  trimCard.className = 'video-card';
  const trimHd = document.createElement('h4');
  trimHd.textContent = 'Trim';
  const trimRow = document.createElement('div');
  trimRow.className = 'video-field-row';
  const trimStart = document.createElement('input');
  trimStart.type = 'number';
  trimStart.min = '0';
  trimStart.step = '0.1';
  trimStart.placeholder = 'Start (seconds)';
  trimStart.setAttribute('aria-label', 'Trim start, in seconds');
  const trimEnd = document.createElement('input');
  trimEnd.type = 'number';
  trimEnd.min = '0';
  trimEnd.step = '0.1';
  trimEnd.placeholder = 'End (seconds)';
  trimEnd.setAttribute('aria-label', 'Trim end, in seconds');
  trimRow.append(trimStart, trimEnd);
  const trimPreciseLabel = document.createElement('label');
  const trimPrecise = document.createElement('input');
  trimPrecise.type = 'checkbox';
  trimPreciseLabel.append(trimPrecise, document.createTextNode(' Make the cut exact (a little slower)'));
  const trimBtn = document.createElement('button');
  trimBtn.type = 'button';
  trimBtn.className = 'btn-primary';
  trimBtn.textContent = 'Trim';
  trimCard.append(trimHd, trimRow, trimPreciseLabel, trimBtn);

  // -- join -----------------------------------------------------------------
  const joinCard = document.createElement('div');
  joinCard.className = 'video-card';
  const joinHd = document.createElement('h4');
  joinHd.textContent = 'Join clips, in order';
  const joinList = document.createElement('ul');
  joinList.className = 'contacts-list';
  const joinRow = document.createElement('div');
  joinRow.className = 'video-field-row';
  const joinAddBtn = document.createElement('button');
  joinAddBtn.type = 'button';
  joinAddBtn.className = 'btn-ghost';
  joinAddBtn.textContent = 'Add the picked file';
  const joinBtn = document.createElement('button');
  joinBtn.type = 'button';
  joinBtn.className = 'btn-primary';
  joinBtn.textContent = 'Join';
  joinRow.append(joinAddBtn, joinBtn);
  joinCard.append(joinHd, joinList, joinRow);

  let joinFiles = [];
  function renderJoinList() {
    joinList.innerHTML = '';
    if (!joinFiles.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No clips added yet.';
      joinList.appendChild(li);
      return;
    }
    joinFiles.forEach((f, i) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${i + 1}. ${f}`;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'msg-action-btn';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        joinFiles = joinFiles.filter((_, idx) => idx !== i);
        renderJoinList();
      });
      li.append(label, removeBtn);
      joinList.appendChild(li);
    });
  }
  renderJoinList();

  // -- captions -----------------------------------------------------------
  const capCard = document.createElement('div');
  capCard.className = 'video-card';
  const capHd = document.createElement('h4');
  capHd.textContent = 'Captions';
  const burnLabel = document.createElement('label');
  const burnCheck = document.createElement('input');
  burnCheck.type = 'checkbox';
  burnLabel.append(burnCheck, document.createTextNode(' Burn the captions into the video (otherwise Scout writes a caption file next to it)'));
  const capBtn = document.createElement('button');
  capBtn.type = 'button';
  capBtn.className = 'btn-primary';
  capBtn.textContent = 'Add captions';
  capCard.append(capHd, burnLabel, capBtn);

  // -- cut silence ------------------------------------------------------
  const silenceCard = document.createElement('div');
  silenceCard.className = 'video-card';
  const silenceHd = document.createElement('h4');
  silenceHd.textContent = 'Cut the quiet parts';
  const silenceSliderLabel = document.createElement('label');
  silenceSliderLabel.textContent = 'How much quiet counts';
  const silenceSlider = document.createElement('input');
  silenceSlider.type = 'range';
  silenceSlider.min = '-50';
  silenceSlider.max = '-20';
  silenceSlider.step = '1';
  silenceSlider.value = '-35';
  silenceSlider.setAttribute('aria-label', 'How much quiet counts as silence');
  const silenceValue = document.createElement('p');
  silenceValue.className = 'settings-note';
  const silenceBtn = document.createElement('button');
  silenceBtn.type = 'button';
  silenceBtn.className = 'btn-primary';
  silenceBtn.textContent = 'Cut the quiet parts';
  silenceCard.append(silenceHd, silenceSliderLabel, silenceSlider, silenceValue, silenceBtn);
  function renderSilenceValue() {
    silenceValue.textContent = describeThreshold(Number(silenceSlider.value));
  }
  silenceSlider.addEventListener('input', renderSilenceValue);
  renderSilenceValue();

  // -- shorts -------------------------------------------------------------
  const shortsCard = document.createElement('div');
  shortsCard.className = 'video-card';
  const shortsHd = document.createElement('h4');
  shortsHd.textContent = 'Make a vertical video';
  const shortsModeRow = document.createElement('div');
  shortsModeRow.className = 'video-field-row';
  const cropRadio = document.createElement('input');
  cropRadio.type = 'radio';
  cropRadio.name = 'shortsMode';
  cropRadio.id = 'videoShortsCrop';
  cropRadio.checked = true;
  const cropLabel = document.createElement('label');
  cropLabel.setAttribute('for', 'videoShortsCrop');
  cropLabel.textContent = 'Crop to fill the screen';
  const blurRadio = document.createElement('input');
  blurRadio.type = 'radio';
  blurRadio.name = 'shortsMode';
  blurRadio.id = 'videoShortsBlur';
  const blurLabel = document.createElement('label');
  blurLabel.setAttribute('for', 'videoShortsBlur');
  blurLabel.textContent = 'Keep the whole picture, blur the edges';
  shortsModeRow.append(cropRadio, cropLabel, blurRadio, blurLabel);
  const shortsBtn = document.createElement('button');
  shortsBtn.type = 'button';
  shortsBtn.className = 'btn-primary';
  shortsBtn.textContent = 'Make it vertical';
  shortsCard.append(shortsHd, shortsModeRow, shortsBtn);

  toolsSection.append(trimCard, joinCard, capCard, silenceCard, shortsCard);

  // -- jobs -----------------------------------------------------------------
  const jobsHd = document.createElement('h4');
  jobsHd.textContent = 'Jobs';
  const jobsList = document.createElement('div');
  jobsList.className = 'video-jobs';

  body.append(
    setupCard, readyNote,
    fileHd, fileRow, fileInfo, filesList,
    toolsSection,
    jobsHd, jobsList,
  );

  // -- server calls -----------------------------------------------------

  async function loadStatus() {
    try {
      const data = await host.api.getJson('/api/video/status');
      setupCard.hidden = data.present;
      readyNote.hidden = !data.present;
      toolsSection.hidden = !data.present;
      setupBtn.hidden = !data.canSetUp;
      if (!data.present) {
        setupNote.textContent = data.canSetUp
          ? 'Video tools are not set up yet. They download once (about 120 MB) and then work offline.'
          : data.note || 'Video tools are not available on this computer yet.';
      }
    } catch (err) {
      setupNote.textContent = "Couldn't check on the video tools. " + (err.message || '');
    }
  }

  async function loadFiles() {
    filesList.innerHTML = '';
    try {
      const data = await host.api.getJson('/api/video/files');
      const files = data.files || [];
      if (!files.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'No files in the studio folder yet. Copy a video there, or type a full path above.';
        filesList.appendChild(li);
        return;
      }
      for (const f of files) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-ghost';
        btn.textContent = `${f.name} (${formatMB(f.size)})`;
        btn.addEventListener('click', () => {
          fileInput.value = f.name;
        });
        li.appendChild(btn);
        filesList.appendChild(li);
      }
    } catch {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = "Couldn't list files.";
      filesList.appendChild(li);
    }
  }

  async function startJob(post) {
    try {
      await post();
      await refreshJobs();
    } catch (err) {
      host.toast('Could not start that. ' + (err.message || ''), { kind: 'error' });
    }
  }

  function toolLabel(tool) {
    return TOOL_LABEL[tool] || tool;
  }

  function renderJobs() {
    jobsList.innerHTML = '';
    const list = Array.from(jobsById.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No jobs yet.';
      jobsList.appendChild(empty);
      return;
    }
    for (const job of list) {
      const row = document.createElement('div');
      row.className = 'video-job';
      const head = document.createElement('div');
      head.className = 'video-job-head';
      const label = document.createElement('span');
      label.textContent = toolLabel(job.tool);
      const stateNote = document.createElement('span');
      stateNote.className = 'settings-note';
      stateNote.textContent = job.message || job.state || '';
      head.append(label, stateNote);
      const { track, fill } = progressRow();
      fill.style.width = `${Math.max(0, Math.min(100, job.percent || 0))}%`;
      row.append(head, track);

      if (job.state === 'queued' || job.state === 'running') {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'msg-action-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', async () => {
          cancelBtn.disabled = true;
          try {
            await host.api.postJson('/api/video/cancel', { jobId: job.id });
          } catch (err) {
            host.toast('Could not cancel that. ' + (err.message || ''), { kind: 'error' });
          }
        });
        row.appendChild(cancelBtn);
      }
      if (job.state === 'done' && job.output) {
        const resultNote = document.createElement('p');
        resultNote.className = 'settings-note';
        resultNote.textContent = `Saved to ${job.output}. Open the studio/out folder on this stick to find it.`;
        row.appendChild(resultNote);
      }
      if (job.state === 'failed' && job.error) {
        const errNote = document.createElement('p');
        errNote.className = 'settings-note';
        errNote.textContent = job.error;
        row.appendChild(errNote);
      }
      jobsList.appendChild(row);
    }
  }

  async function refreshJobs() {
    try {
      const data = await host.api.getJson('/api/video/jobs');
      jobsById = new Map((data.jobs || []).map((j) => [j.id, j]));
      renderJobs();
    } catch {
      // best effort: the list just stays as it was
    }
  }

  host.api.events.on('video', (data) => {
    if (!data || !data.jobId) return;

    if (data.jobId === setupJobId) {
      setupProgress.fill.style.width = `${Math.max(0, Math.min(100, data.percent || 0))}%`;
      setupNote.textContent = data.message || 'Downloading';
      if (data.phase === 'done') {
        setupJobId = null;
        loadStatus();
      } else if (data.phase === 'failed' || data.phase === 'cancelled') {
        setupJobId = null;
        setupBtn.disabled = false;
        setupProgress.track.hidden = true;
        host.toast('Could not set up the video tools.', { kind: 'error' });
      }
    }

    const existing = jobsById.get(data.jobId);
    if (existing) {
      existing.phase = data.phase;
      existing.percent = data.percent;
      existing.message = data.message;
      if (data.phase === 'running' || data.phase === 'queued') existing.state = data.phase;
      renderJobs();
    }
    if (TERMINAL_PHASES.has(data.phase)) refreshJobs();
  });

  // -- button wiring ------------------------------------------------------

  setupBtn.addEventListener('click', async () => {
    setupBtn.disabled = true;
    setupProgress.track.hidden = false;
    try {
      const res = await host.api.postJson('/api/video/setup', {});
      setupJobId = res.jobId;
      await refreshJobs();
    } catch (err) {
      host.toast('Could not start the download. ' + (err.message || ''), { kind: 'error' });
      setupBtn.disabled = false;
      setupProgress.track.hidden = true;
    }
  });

  refreshFilesBtn.addEventListener('click', loadFiles);

  checkBtn.addEventListener('click', async () => {
    const file = requireFile();
    if (!file) return;
    fileInfo.textContent = 'Checking';
    try {
      const info = await host.api.postJson('/api/video/probe', { file });
      const parts = [];
      if (typeof info.durationSec === 'number') {
        const m = Math.floor(info.durationSec / 60);
        const s = Math.round(info.durationSec % 60);
        parts.push(`${m}:${String(s).padStart(2, '0')} long`);
      }
      if (info.width && info.height) parts.push(`${info.width}x${info.height}`);
      parts.push(info.hasAudio ? 'has sound' : 'no sound');
      fileInfo.textContent = parts.join(', ') + '.';
    } catch (err) {
      fileInfo.textContent = "Couldn't check that file. " + (err.message || '');
    }
  });

  trimBtn.addEventListener('click', async () => {
    const file = requireFile();
    if (!file) return;
    const startSec = Number(trimStart.value);
    const endSec = Number(trimEnd.value);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      host.toast('Pick a start and end time where the end comes after the start.', { kind: 'error' });
      return;
    }
    await startJob(() => host.api.postJson('/api/video/trim', { file, startSec, endSec, precise: trimPrecise.checked }));
  });

  joinAddBtn.addEventListener('click', () => {
    const file = requireFile();
    if (!file) return;
    joinFiles.push(file);
    renderJoinList();
  });

  joinBtn.addEventListener('click', async () => {
    if (joinFiles.length < 2) {
      host.toast('Add at least two clips first.', { kind: 'error' });
      return;
    }
    await startJob(() => host.api.postJson('/api/video/join', { files: joinFiles }));
    joinFiles = [];
    renderJoinList();
  });

  capBtn.addEventListener('click', async () => {
    const file = requireFile();
    if (!file) return;
    await startJob(() => host.api.postJson('/api/video/captions', { file, burnIn: burnCheck.checked }));
  });

  silenceBtn.addEventListener('click', async () => {
    const file = requireFile();
    if (!file) return;
    await startJob(() => host.api.postJson('/api/video/silence', { file, thresholdDb: Number(silenceSlider.value) }));
  });

  shortsBtn.addEventListener('click', async () => {
    const file = requireFile();
    if (!file) return;
    const mode = blurRadio.checked ? 'blur' : 'crop';
    await startJob(() => host.api.postJson('/api/video/shorts', { file, mode }));
  });

  const originalOpen = win.open;
  win.open = function open() {
    originalOpen();
    loadStatus();
    loadFiles();
    refreshJobs();
  };

  return win;
}
