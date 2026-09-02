// windows/profiles.js: "Who's asking?", the PIN lock, and the taskbar
// profile chip with its unlock countdown and Lock button. This one behaves
// like a system dialog rather than a normal content window (host.createWindow
// is not used here), but it still exposes the { open, close, toggle,
// isOpen } shape so app.js's start menu can treat it the same way.

const STORAGE_KEY = 'stickos_profile_id';

function readStoredId() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}
function writeStoredId(id) {
  try {
    if (id == null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(id));
  } catch {
    // storage unavailable (private browsing, disabled cookies): fine, just
    // means the picker shows again next visit.
  }
}

function isUnlocked(profile) {
  return !!(profile && profile.unlockedUntil && new Date(profile.unlockedUntil).getTime() > Date.now());
}

function minutesLeft(unlockedUntil) {
  if (!unlockedUntil) return 0;
  const ms = new Date(unlockedUntil).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 60000));
}

export function mount(host) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay profile-overlay';
  overlay.hidden = true;

  const card = document.createElement('div');
  card.className = 'modal-card profile-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', "Who's asking");

  const heading = document.createElement('h2');
  heading.textContent = "Who's asking?";

  const listEl = document.createElement('div');
  listEl.className = 'profile-list';

  const newRow = document.createElement('div');
  newRow.className = 'profile-new';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 40;
  nameInput.placeholder = 'Add a name';
  nameInput.setAttribute('aria-label', 'New profile name');
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-primary';
  addBtn.textContent = 'Add';
  newRow.append(nameInput, addBtn);

  const pinBox = document.createElement('div');
  pinBox.className = 'profile-pin';
  pinBox.hidden = true;
  const pinPrompt = document.createElement('p');
  const pinInput = document.createElement('input');
  pinInput.type = 'password';
  pinInput.inputMode = 'numeric';
  pinInput.pattern = '[0-9]*';
  pinInput.maxLength = 8;
  pinInput.placeholder = 'PIN';
  pinInput.setAttribute('aria-label', 'PIN');
  const pinActions = document.createElement('div');
  pinActions.className = 'profile-pin-actions';
  const pinBack = document.createElement('button');
  pinBack.type = 'button';
  pinBack.className = 'btn-ghost';
  pinBack.textContent = 'Back';
  const pinGo = document.createElement('button');
  pinGo.type = 'button';
  pinGo.className = 'btn-primary';
  pinGo.textContent = 'Unlock';
  pinActions.append(pinBack, pinGo);
  const pinError = document.createElement('p');
  pinError.className = 'profile-pin-error';
  pinError.hidden = true;
  pinBox.append(pinPrompt, pinInput, pinActions, pinError);

  card.append(heading, listEl, newRow, pinBox);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  let profiles = [];
  let pendingProfile = null;

  function open() {
    overlay.hidden = false;
    showList();
    refresh();
  }
  function close() {
    overlay.hidden = true;
  }
  function toggle() {
    if (overlay.hidden) open();
    else close();
  }
  function showList() {
    pinBox.hidden = true;
    listEl.hidden = false;
    newRow.hidden = false;
  }
  function showPin(profile) {
    pendingProfile = profile;
    listEl.hidden = true;
    newRow.hidden = true;
    pinBox.hidden = false;
    pinError.hidden = true;
    pinInput.value = '';
    pinPrompt.textContent = profile.name + ' has a PIN. Enter it to continue.';
    pinInput.focus();
  }

  function renderList() {
    listEl.innerHTML = '';
    if (!profiles.length) {
      const empty = document.createElement('p');
      empty.className = 'profile-empty';
      empty.textContent = 'No one is set up yet. Add a name below to get started.';
      listEl.appendChild(empty);
      return;
    }
    for (const profile of profiles) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'profile-row';
      const name = document.createElement('span');
      name.className = 'profile-row-name';
      name.textContent = profile.name;
      row.appendChild(name);
      if (profile.hasPin) {
        const lock = document.createElement('span');
        lock.className = 'profile-row-lock';
        lock.textContent = isUnlocked(profile) ? 'unlocked' : 'locked';
        row.appendChild(lock);
      }
      row.addEventListener('click', () => choose(profile));
      listEl.appendChild(row);
    }
  }

  async function refresh() {
    try {
      const data = await host.api.getJson('/api/profiles');
      profiles = (data && data.profiles) || [];
      renderList();
    } catch (err) {
      console.warn('Scout: could not load profiles', err);
    }
  }

  function choose(profile) {
    if (profile.hasPin && !isUnlocked(profile)) {
      showPin(profile);
      return;
    }
    select(profile);
  }

  function select(profile) {
    host.setProfile(profile);
    writeStoredId(profile.id);
    close();
    renderChip(profile);
  }

  addBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    addBtn.disabled = true;
    try {
      const created = await host.api.postJson('/api/profiles', { name });
      nameInput.value = '';
      await refresh();
      const match = (created && created.id) ? profiles.find((p) => p.id === created.id) : null;
      select(match || created);
    } catch (err) {
      host.toast('Could not add that profile. ' + (err.message || ''), { kind: 'error' });
    } finally {
      addBtn.disabled = false;
    }
  });
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addBtn.click();
  });

  pinBack.addEventListener('click', showList);
  async function submitPin() {
    if (!pendingProfile) return;
    const pin = pinInput.value.trim();
    if (!pin) return;
    pinGo.disabled = true;
    try {
      const result = await host.api.postJson('/api/profiles/unlock', { profileId: pendingProfile.id, pin });
      if (result && result.ok) {
        pendingProfile.unlockedUntil = result.unlockedUntil;
        select(pendingProfile);
      } else {
        pinError.hidden = false;
        pinError.textContent = result && result.lockedForSeconds
          ? 'Too many tries. Try again in ' + result.lockedForSeconds + ' seconds.'
          : 'That PIN did not match.';
        pinInput.value = '';
        pinInput.focus();
      }
    } catch (err) {
      pinError.hidden = false;
      pinError.textContent = err.message || 'Could not check that PIN.';
    } finally {
      pinGo.disabled = false;
    }
  }
  pinGo.addEventListener('click', submitPin);
  pinInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitPin();
  });

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay && host.getProfile()) close();
  });

  // ---- taskbar chip -------------------------------------------------------

  let countdownTimer = null;

  function renderChip(profile) {
    const chip = host.profileChipEl;
    if (!profile) {
      chip.hidden = true;
      chip.innerHTML = '';
      document.documentElement.classList.remove('locked');
      if (countdownTimer) clearInterval(countdownTimer);
      return;
    }
    chip.hidden = false;
    chip.innerHTML = '';
    const nameEl = document.createElement('span');
    nameEl.className = 'profile-chip-name';
    nameEl.textContent = profile.name;
    chip.appendChild(nameEl);

    if (profile.hasPin) {
      const statusEl = document.createElement('span');
      statusEl.className = 'profile-chip-status';
      chip.appendChild(statusEl);
      const lockBtn = document.createElement('button');
      lockBtn.type = 'button';
      lockBtn.className = 'profile-chip-lock';
      lockBtn.textContent = 'Lock';
      lockBtn.addEventListener('click', () => doLock(profile));
      chip.appendChild(lockBtn);

      function paint() {
        const unlocked = isUnlocked(profile);
        document.documentElement.classList.toggle('locked', !unlocked);
        statusEl.textContent = unlocked ? 'unlocked, ' + minutesLeft(profile.unlockedUntil) + ' min left' : 'locked';
        lockBtn.hidden = !unlocked;
      }
      paint();
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = setInterval(paint, 15000);
      chip._paint = paint;
    } else {
      document.documentElement.classList.remove('locked');
      if (countdownTimer) clearInterval(countdownTimer);
    }
  }

  async function doLock(profile) {
    try {
      await host.api.postJson('/api/profiles/lock', { profileId: profile.id });
      profile.unlockedUntil = null;
      if (host.profileChipEl._paint) host.profileChipEl._paint();
      document.documentElement.classList.add('locked');
    } catch (err) {
      host.toast('Could not lock. ' + (err.message || ''), { kind: 'error' });
    }
  }

  host.api.events.on('lock', (data) => {
    const current = host.getProfile();
    if (!current || !data || data.profileId !== current.id) return;
    current.unlockedUntil = data.unlockedUntil || null;
    renderChip(current);
  });

  host.onProfileChange((profile) => {
    renderChip(profile);
  });

  return { id: 'profiles', title: "Who's Asking", open, close, toggle, isOpen: () => !overlay.hidden };
}

// Called once, right after boot finishes, to decide whether the picker needs
// to show at all: a remembered profile that still exists (and is not
// PIN-locked) is selected silently, a locked one goes straight to its PIN
// box, and anything else falls back to the full "who's asking" list.
export async function checkFirstRun(host) {
  const ctrl = host.windows.profiles;
  let profiles = [];
  try {
    const data = await host.api.getJson('/api/profiles');
    profiles = (data && data.profiles) || [];
  } catch (err) {
    console.warn('Scout: could not load profiles on start', err);
    return;
  }
  const storedId = readStoredId();
  const remembered = storedId != null ? profiles.find((p) => p.id === storedId) : null;
  if (remembered && !(remembered.hasPin && !isUnlocked(remembered))) {
    // A remembered profile that is not sitting behind a PIN right now:
    // select it quietly and skip the picker.
    host.setProfile(remembered);
  } else {
    // No memory of who this is, or the remembered profile needs its PIN
    // again: show the picker (clicking the remembered name routes into the
    // PIN box on its own, the same as any other locked profile).
    ctrl.open();
  }
}
