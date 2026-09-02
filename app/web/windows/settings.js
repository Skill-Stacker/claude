// windows/settings.js: voice picker, STT engine, contacts, GPU status line,
// New Session. The chosen voice has no save route in API.md (it travels
// per-request as POST /api/tts's optional `voice` field), so this stores
// the choice under the localStorage key "stickos:voice" for voice.js to
// read when it builds a /api/tts call; see the final report for that note.

const VOICE_STORAGE_KEY = 'stickos:voice';

function readStoredVoice() {
  try {
    return localStorage.getItem(VOICE_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}
function writeStoredVoice(id) {
  try {
    localStorage.setItem(VOICE_STORAGE_KEY, id || '');
  } catch {
    // no storage available: the picker still works this session
  }
}

function engineId(entry) {
  return typeof entry === 'string' ? entry : entry && (entry.id || entry.name);
}
function engineLabel(entry) {
  if (typeof entry === 'string') return entry;
  return (entry && (entry.label || entry.name || entry.id)) || 'engine';
}

export function mount(host) {
  const win = host.createWindow({ id: 'settings', title: 'Settings', icon: 'G', width: 440, height: 560, left: 220, top: 90 });
  const body = win.body;
  body.classList.add('settings-body');

  // -- voice ------------------------------------------------------------
  const voiceLabel = document.createElement('label');
  voiceLabel.textContent = "Scout's voice";
  const voiceSelect = document.createElement('select');
  voiceSelect.id = 'settingsVoiceSelect';
  voiceLabel.setAttribute('for', voiceSelect.id);

  // -- STT --------------------------------------------------------------
  const sttLabel = document.createElement('label');
  sttLabel.textContent = 'Listening engine';
  const sttSelect = document.createElement('select');
  sttSelect.id = 'settingsSttSelect';
  sttLabel.setAttribute('for', sttSelect.id);
  const sttNote = document.createElement('p');
  sttNote.className = 'settings-note';

  // -- connected accounts -----------------------------------------------
  const accountsHd = document.createElement('h4');
  accountsHd.textContent = 'Connected accounts';
  const gmailStatusLine = document.createElement('p');
  gmailStatusLine.className = 'settings-note';
  const calendarStatusLine = document.createElement('p');
  calendarStatusLine.className = 'settings-note';
  const openConnectBtn = document.createElement('button');
  openConnectBtn.type = 'button';
  openConnectBtn.className = 'btn-ghost';
  openConnectBtn.textContent = 'Open Connect';
  openConnectBtn.addEventListener('click', () => host.windows.connect && host.windows.connect.open());

  // -- GPU ----------------------------------------------------------------
  const gpuHd = document.createElement('h4');
  gpuHd.textContent = 'Hardware';
  const gpuLine = document.createElement('p');
  gpuLine.className = 'settings-note';
  gpuLine.textContent = 'Checking';

  // -- contacts -------------------------------------------------------------
  const contactsHd = document.createElement('h4');
  contactsHd.textContent = 'Contacts';
  const contactsList = document.createElement('ul');
  contactsList.className = 'contacts-list';
  const contactForm = document.createElement('div');
  contactForm.className = 'contact-form';
  const contactName = document.createElement('input');
  contactName.type = 'text';
  contactName.placeholder = 'Name';
  contactName.setAttribute('aria-label', 'Contact name');
  const contactAddress = document.createElement('input');
  contactAddress.type = 'email';
  contactAddress.placeholder = 'Email address';
  contactAddress.setAttribute('aria-label', 'Contact email address');
  const contactAddBtn = document.createElement('button');
  contactAddBtn.type = 'button';
  contactAddBtn.className = 'btn-ghost';
  contactAddBtn.textContent = 'Add';
  contactForm.append(contactName, contactAddress, contactAddBtn);

  // -- session --------------------------------------------------------------
  const sessionHd = document.createElement('h4');
  sessionHd.textContent = 'Session';
  const newSessionBtn = document.createElement('button');
  newSessionBtn.type = 'button';
  newSessionBtn.className = 'btn-primary';
  newSessionBtn.textContent = 'New Session';
  const sessionNote = document.createElement('p');
  sessionNote.className = 'settings-note';
  sessionNote.textContent = 'Sums up this conversation and starts fresh. Scout keeps what matters and lets the rest go.';

  body.append(
    voiceLabel, voiceSelect,
    sttLabel, sttSelect, sttNote,
    accountsHd, gmailStatusLine, calendarStatusLine, openConnectBtn,
    gpuHd, gpuLine,
    contactsHd, contactsList, contactForm,
    sessionHd, newSessionBtn, sessionNote,
  );

  async function loadVoices() {
    try {
      const data = await host.api.getJson('/api/voices');
      const voices = Array.isArray(data.voices) ? data.voices : [];
      voiceSelect.innerHTML = '';
      for (const v of voices) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.label + (v.grade ? ' (' + v.grade + ')' : '');
        voiceSelect.appendChild(opt);
      }
      const stored = readStoredVoice();
      const wanted = stored || data.default;
      if (wanted) voiceSelect.value = wanted;
    } catch (err) {
      voiceSelect.innerHTML = '<option value="">Not available yet</option>';
    }
  }
  voiceSelect.addEventListener('change', () => {
    writeStoredVoice(voiceSelect.value);
    if (host.stickos.voice && typeof host.stickos.voice.setVoice === 'function') {
      host.stickos.voice.setVoice(voiceSelect.value);
    }
    host.bus.emit('voice-choice', voiceSelect.value);
  });

  async function loadStt() {
    try {
      const data = await host.api.getJson('/api/stt/engines');
      const engines = Array.isArray(data.engines) ? data.engines : [];
      sttSelect.innerHTML = '';
      for (const e of engines) {
        const opt = document.createElement('option');
        opt.value = engineId(e);
        opt.textContent = engineLabel(e);
        sttSelect.appendChild(opt);
      }
      if (data.current) sttSelect.value = data.current;
      sttNote.textContent = '';
    } catch (err) {
      sttSelect.innerHTML = '<option value="">Not available yet</option>';
      sttNote.textContent = '';
    }
  }
  sttSelect.addEventListener('change', async () => {
    sttNote.textContent = 'Saving';
    try {
      await host.api.postJson('/api/stt/engine', { engine: sttSelect.value });
      sttNote.textContent = 'Saved.';
      setTimeout(() => {
        sttNote.textContent = '';
      }, 2000);
    } catch (err) {
      sttNote.textContent = 'Could not save that. ' + (err.message || '');
    }
  });

  async function loadAccounts() {
    const profile = host.getProfile();
    if (!profile) {
      gmailStatusLine.textContent = 'Pick who you are first.';
      calendarStatusLine.textContent = '';
      return;
    }
    try {
      const data = await host.api.getJson('/api/google/status?profileId=' + encodeURIComponent(profile.id));
      const gmail = data.gmail || {};
      const calendar = data.calendar || {};
      gmailStatusLine.textContent = gmail.connected
        ? 'Gmail: connected as ' + (gmail.address || 'your account') + '.'
        : 'Gmail: not connected yet.';
      calendarStatusLine.textContent = calendar.connected
        ? 'Calendar: connected' + (calendar.staleMinutes != null ? ', last checked ' + calendar.staleMinutes + ' min ago' : '') + '.'
        : 'Calendar: not connected yet.';
    } catch (err) {
      gmailStatusLine.textContent = "Couldn't check Gmail.";
      calendarStatusLine.textContent = "Couldn't check the calendar.";
    }
  }

  async function loadGpu() {
    try {
      const status = await host.api.getJson('/api/status');
      const gpu = status.gpu || (status.engine && status.engine.gpu) || null;
      if (gpu && typeof gpu.available === 'boolean') {
        gpuLine.textContent = gpu.available ? 'Using your graphics card' + (gpu.detail ? ', ' + gpu.detail : '') + '.' : 'Using your processor.';
      } else {
        gpuLine.textContent = 'Not known yet.';
      }
    } catch (err) {
      gpuLine.textContent = "Couldn't check.";
    }
  }

  function renderContacts(contacts) {
    contactsList.innerHTML = '';
    if (!contacts.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No contacts yet.';
      contactsList.appendChild(li);
      return;
    }
    for (const c of contacts) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = c.name + ' (' + c.address + ')';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'msg-action-btn';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', async () => {
        const ok = await host.showConfirm({ title: 'Remove contact', message: 'Remove ' + c.name + ' from contacts?', confirmLabel: 'Remove', danger: true });
        if (!ok) return;
        const profile = host.getProfile();
        try {
          await host.api.postJson('/api/contacts/remove', { profileId: profile.id, id: c.id, address: c.address });
          await loadContacts();
        } catch (err) {
          host.toast('Could not remove that contact. ' + (err.message || ''), { kind: 'error' });
        }
      });
      li.append(label, removeBtn);
      contactsList.appendChild(li);
    }
  }

  async function loadContacts() {
    const profile = host.getProfile();
    if (!profile) {
      contactsList.innerHTML = '<li class="empty">Pick who you are first.</li>';
      return;
    }
    try {
      const data = await host.api.getJson('/api/contacts?profileId=' + encodeURIComponent(profile.id));
      renderContacts(Array.isArray(data.contacts) ? data.contacts : []);
    } catch (err) {
      contactsList.innerHTML = '<li class="empty">Could not load contacts.</li>';
    }
  }

  contactAddBtn.addEventListener('click', async () => {
    const profile = host.getProfile();
    if (!profile) return;
    const name = contactName.value.trim();
    const address = contactAddress.value.trim();
    if (!name || !address) return;
    contactAddBtn.disabled = true;
    try {
      await host.api.postJson('/api/contacts', { profileId: profile.id, name, address });
      contactName.value = '';
      contactAddress.value = '';
      await loadContacts();
    } catch (err) {
      host.toast('Could not add that contact. ' + (err.message || ''), { kind: 'error' });
    } finally {
      contactAddBtn.disabled = false;
    }
  });

  newSessionBtn.addEventListener('click', async () => {
    const profile = host.getProfile();
    if (!profile) return;
    newSessionBtn.disabled = true;
    try {
      await host.api.postJson('/api/session/new', { profileId: profile.id });
      host.toast('Started a new session.');
    } catch (err) {
      host.toast('Could not start a new session. ' + (err.message || ''), { kind: 'error' });
    } finally {
      newSessionBtn.disabled = false;
    }
  });

  const originalOpen = win.open;
  win.open = function open() {
    originalOpen();
    loadVoices();
    loadStt();
    loadAccounts();
    loadGpu();
    loadContacts();
  };
  host.onProfileChange(() => {
    if (win.isOpen()) {
      loadAccounts();
      loadContacts();
    }
  });

  return win;
}
