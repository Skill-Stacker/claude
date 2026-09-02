// app.js: the desktop shell. Builds the window chrome, the taskbar and
// start menu, boots every window module, and assembles window.StickOS, the
// surface lamp.js and voice.js attach to. See API.md for the routes this
// page talks to and the file header comments in api.js for the transport.

import * as api from './api.js';
import * as bootWindow from './windows/boot.js';
import * as profilesWindow from './windows/profiles.js';
import * as chatWindow from './windows/chat.js';
import * as todayWindow from './windows/today.js';
import * as connectWindow from './windows/connect.js';
import * as mailWindow from './windows/mail.js';
import * as calendarWindow from './windows/calendar.js';
import * as netlogWindow from './windows/netlog.js';
import * as settingsWindow from './windows/settings.js';
import * as linksWindow from './windows/links.js';
import * as monitorWindow from './windows/monitor.js';
import * as imagesWindow from './windows/images.js';
// windows/video.js belongs to the studio milestone and is still being
// finished elsewhere; it is loaded further down with the same guarded
// dynamic import used for lamp.js and voice.js, not a static import here,
// so a missing or broken module never breaks the rest of the page.

// ---------------------------------------------------------------------------
// A tiny pub-sub for things windows tell each other (profile switched, mood
// changed, a window should open). Separate from api.events, which is the
// server's own SSE bus.
// ---------------------------------------------------------------------------

function createBus() {
  const listeners = new Map();
  function on(type, fn) {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    set.add(fn);
    return () => off(type, fn);
  }
  function off(type, fn) {
    const set = listeners.get(type);
    if (set) set.delete(fn);
  }
  function emit(type, data) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(data);
      } catch (err) {
        console.error('Scout: a bus handler for', type, 'threw', err);
      }
    }
  }
  return { on, off, emit };
}

const bus = createBus();

// ---------------------------------------------------------------------------
// DOM references (index.html owns this markup; see its own comments)
// ---------------------------------------------------------------------------

const bootEl = document.getElementById('boot');
const desktopEl = document.getElementById('desktop');
const topbarBrand = document.getElementById('startMenuBtn');
const startBtn = document.getElementById('startBtn');
const startMenuEl = document.getElementById('startmenu');
const iconsEl = document.getElementById('desktopIcons');
const tasksEl = document.getElementById('tasks');
const clockTimeEl = document.getElementById('clockTime');
const clockDateEl = document.getElementById('clockDate');
const enginePillEl = document.getElementById('enginePill');
const engineDotEl = document.getElementById('engineDot');
const engineTxtEl = document.getElementById('engineTxt');
const profileChipEl = document.getElementById('profileChip');
const toastHostEl = document.getElementById('toast-host');
const micBtn = document.getElementById('mic');
const micLabelEl = document.getElementById('micLabel');
const voiceStatusEl = document.getElementById('voice-status');

const taskbarEl = document.querySelector('.taskbar');
const topbarEl = document.querySelector('.topbar');

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function toast(message, { kind = 'info', duration = 4200 } = {}) {
  if (!message) return;
  const el = document.createElement('div');
  el.className = 'toast toast-' + kind;
  el.textContent = message;
  toastHostEl.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ---------------------------------------------------------------------------
// A generic yes/no modal, for anything outside the chat window's own
// confirm cards (chat renders its confirm events inline, with a PIN field
// and url-open handling of its own; this is the plain "are you sure").
// ---------------------------------------------------------------------------

function showConfirm({ title = 'Are you sure', message = '', confirmLabel = 'Yes', cancelLabel = 'No', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const card = document.createElement('div');
    card.className = 'modal-card';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');

    const h3 = document.createElement('h3');
    h3.textContent = title;
    const p = document.createElement('p');
    p.textContent = message;
    const btnRow = document.createElement('div');
    btnRow.className = 'modal-btns';
    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'btn-ghost';
    noBtn.textContent = cancelLabel;
    const yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = danger ? 'btn-primary btn-danger' : 'btn-primary';
    yesBtn.textContent = confirmLabel;

    btnRow.append(noBtn, yesBtn);
    card.append(h3, p, btnRow);
    overlay.appendChild(card);

    function done(value) {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    }
    function onKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        done(false);
      }
    }
    document.addEventListener('keydown', onKey, true);
    yesBtn.addEventListener('click', () => done(true));
    noBtn.addEventListener('click', () => done(false));
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) done(false);
    });

    document.body.appendChild(overlay);
    yesBtn.focus();
  });
}

// ---------------------------------------------------------------------------
// Window chrome: draggable, closable, minimizable, one instance per id.
// ---------------------------------------------------------------------------

let zTop = 50;
const controllers = new Map();
const openStack = [];

function bringToFront(el) {
  zTop += 1;
  el.style.zIndex = String(zTop);
}

function renderTaskbar() {
  tasksEl.innerHTML = '';
  for (const id of openStack) {
    const ctrl = controllers.get(id);
    if (!ctrl) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'task' + (!ctrl.el.hidden ? ' active' : '');
    btn.textContent = ctrl.title;
    btn.addEventListener('click', () => {
      if (ctrl.el.hidden) {
        ctrl.open();
      } else if (Number(ctrl.el.style.zIndex || '0') === zTop) {
        ctrl.minimize();
      } else {
        ctrl.focus();
      }
    });
    tasksEl.appendChild(btn);
  }
}

function makeDraggable(el, handle) {
  let dragging = false;
  let sx = 0;
  let sy = 0;
  let ox = 0;
  let oy = 0;
  handle.addEventListener('mousedown', (event) => {
    if (event.target.closest('.wbtn')) return;
    dragging = true;
    sx = event.clientX;
    sy = event.clientY;
    ox = el.offsetLeft;
    oy = el.offsetTop;
    bringToFront(el);
    event.preventDefault();
  });
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const minTop = topbarEl ? topbarEl.offsetHeight : 34;
    el.style.left = ox + event.clientX - sx + 'px';
    el.style.top = Math.max(minTop, oy + event.clientY - sy) + 'px';
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
  });
}

function createWindow({ id, title, icon = '', width = 420, height = 360, left = 90, top = 70 }) {
  if (controllers.has(id)) return controllers.get(id);

  const el = document.createElement('div');
  el.className = 'win';
  el.id = 'win-' + id;
  el.style.width = width + 'px';
  el.style.height = height + 'px';
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', title);

  const bar = document.createElement('div');
  bar.className = 'win-bar';
  const iconSpan = document.createElement('span');
  iconSpan.className = 'win-icon';
  iconSpan.setAttribute('aria-hidden', 'true');
  iconSpan.textContent = icon;
  const titleSpan = document.createElement('span');
  titleSpan.className = 'win-title';
  titleSpan.textContent = title;
  const btns = document.createElement('div');
  btns.className = 'win-btns';
  const minBtn = document.createElement('button');
  minBtn.type = 'button';
  minBtn.className = 'wbtn wbtn-min';
  minBtn.setAttribute('aria-label', 'Minimize ' + title);
  const maxBtn = document.createElement('button');
  maxBtn.type = 'button';
  maxBtn.className = 'wbtn wbtn-max';
  maxBtn.setAttribute('aria-label', 'Maximize ' + title);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'wbtn wbtn-close';
  closeBtn.setAttribute('aria-label', 'Close ' + title);
  btns.append(minBtn, maxBtn, closeBtn);
  bar.append(iconSpan, titleSpan, btns);

  const body = document.createElement('div');
  body.className = 'win-body';

  el.append(bar, body);
  desktopEl.appendChild(el);
  makeDraggable(el, bar);

  let maximized = false;
  let savedRect = null;

  function open() {
    el.hidden = false;
    if (!openStack.includes(id)) openStack.push(id);
    bringToFront(el);
    renderTaskbar();
    window.requestAnimationFrame(() => {
      const focusable = body.querySelector('input, textarea, button, select, [tabindex]');
      (focusable || bar).focus({ preventScroll: true });
    });
  }
  function close() {
    el.hidden = true;
    const i = openStack.indexOf(id);
    if (i !== -1) openStack.splice(i, 1);
    renderTaskbar();
  }
  function minimize() {
    el.hidden = true;
    renderTaskbar();
  }
  function toggle() {
    if (el.hidden) open();
    else minimize();
  }
  function focusWin() {
    el.hidden = false;
    bringToFront(el);
    renderTaskbar();
  }
  function setTitle(t) {
    titleSpan.textContent = t;
    el.setAttribute('aria-label', t);
  }

  closeBtn.addEventListener('click', close);
  minBtn.addEventListener('click', minimize);
  maxBtn.addEventListener('click', () => {
    if (maximized) {
      Object.assign(el.style, savedRect);
      maximized = false;
    } else {
      savedRect = { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height };
      const topGap = (topbarEl ? topbarEl.offsetHeight : 34) + 8;
      const bottomGap = (taskbarEl ? taskbarEl.offsetHeight : 52) + 16;
      Object.assign(el.style, {
        left: '8px',
        top: topGap + 'px',
        width: 'calc(100% - 16px)',
        height: 'calc(100% - ' + (topGap + bottomGap) + 'px)',
      });
      maximized = true;
    }
    bringToFront(el);
  });

  const controller = { id, title, el, body, open, close, minimize, toggle, focus: focusWin, isOpen: () => !el.hidden, setTitle };
  controllers.set(id, controller);
  return controller;
}

// Escape closes the topmost open window, unless a modal overlay (showConfirm,
// or a window module's own dialog) is already handling Escape itself.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (document.querySelector('.modal-overlay')) return;
  if (!startMenuEl.hidden) {
    setStartMenu(false);
    return;
  }
  let topId = null;
  let topZ = -1;
  for (const id of openStack) {
    const ctrl = controllers.get(id);
    if (!ctrl || ctrl.el.hidden) continue;
    const z = Number(ctrl.el.style.zIndex || '0');
    if (z > topZ) {
      topZ = z;
      topId = id;
    }
  }
  if (topId) controllers.get(topId).close();
});

// ---------------------------------------------------------------------------
// Start menu
// ---------------------------------------------------------------------------

function setStartMenu(show) {
  startMenuEl.hidden = !show;
  if (show) {
    // Always draw above every window, the same way a real Start menu would,
    // no matter how many windows have been focused (and so raised their own
    // z-index) since the page loaded.
    zTop += 1;
    startMenuEl.style.zIndex = String(zTop);
  }
  startBtn.setAttribute('aria-expanded', String(show));
  topbarBrand.setAttribute('aria-expanded', String(show));
}
function toggleStartMenu() {
  setStartMenu(startMenuEl.hidden);
}
startBtn.addEventListener('click', toggleStartMenu);
topbarBrand.addEventListener('click', toggleStartMenu);
topbarBrand.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    toggleStartMenu();
  }
});
document.addEventListener('mousedown', (event) => {
  if (startMenuEl.hidden) return;
  if (startMenuEl.contains(event.target) || event.target === startBtn || event.target === topbarBrand || topbarBrand.contains(event.target)) return;
  setStartMenu(false);
});

// ---------------------------------------------------------------------------
// Profile state
// ---------------------------------------------------------------------------

let currentProfile = null;
function getProfile() {
  return currentProfile;
}
function setProfile(profile) {
  currentProfile = profile || null;
  STICKOS.profile = currentProfile;
  bus.emit('profile', currentProfile);
}
function onProfileChange(fn) {
  return bus.on('profile', fn);
}

// ---------------------------------------------------------------------------
// The public surface. lamp.js and voice.js attach to this once loaded.
// ---------------------------------------------------------------------------

const windows = {};

const STICKOS = {
  api,
  bus,
  windows,
  profile: null,
  lamp: null,
  voice: null,
  setMood(mood) {
    bus.emit('mood', mood);
  },
  say(text) {
    if (windows.chat && typeof windows.chat.sendVoiceText === 'function') {
      windows.chat.sendVoiceText(text);
    }
  },
  stopSpeaking() {
    if (STICKOS.voice && typeof STICKOS.voice.stop === 'function') STICKOS.voice.stop();
  },
  onTranscript(fn) {
    return bus.on('transcript', fn);
  },
  showConfirm,
  toast,
  registerVoice(handlers) {
    if (!handlers || typeof handlers.startHold !== 'function' || typeof handlers.stopHold !== 'function') {
      console.warn('Scout: registerVoice needs startHold and stopHold functions');
      return;
    }
    micBtn.disabled = false;
    micLabelEl.textContent = 'Hold to talk';
    voiceStatusEl.textContent = 'Voice is ready. Hold the button and speak.';
    let holding = false;
    function begin(event) {
      if (holding) return;
      holding = true;
      micBtn.classList.add('listening');
      handlers.startHold();
      if (event) event.preventDefault();
    }
    function end() {
      if (!holding) return;
      holding = false;
      micBtn.classList.remove('listening');
      handlers.stopHold();
    }
    micBtn.addEventListener('mousedown', begin);
    micBtn.addEventListener('touchstart', begin, { passive: false });
    window.addEventListener('mouseup', end);
    window.addEventListener('touchend', end);
    micBtn.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') begin(event);
    });
    micBtn.addEventListener('keyup', (event) => {
      if (event.key === ' ' || event.key === 'Enter') end();
    });
    window.addEventListener('blur', () => {
      if (holding && typeof handlers.cancel === 'function') handlers.cancel();
      holding = false;
      micBtn.classList.remove('listening');
    });
  },
};
window.StickOS = STICKOS;

// ---------------------------------------------------------------------------
// Mount every window module through a shared host object.
// ---------------------------------------------------------------------------

const host = {
  api,
  bus,
  createWindow,
  toast,
  showConfirm,
  getProfile,
  setProfile,
  onProfileChange,
  windows,
  profileChipEl,
  stickos: STICKOS,
};

function mount(id, mod) {
  const ctrl = mod.mount(host);
  windows[id] = ctrl;
  return ctrl;
}

mount('chat', chatWindow);
mount('profiles', profilesWindow);
mount('today', todayWindow);
mount('connect', connectWindow);
mount('mail', mailWindow);
mount('calendar', calendarWindow);
mount('netlog', netlogWindow);
mount('settings', settingsWindow);
mount('links', linksWindow);
mount('monitor', monitorWindow);
mount('images', imagesWindow);

// ---------------------------------------------------------------------------
// Desktop icons + start menu contents
// ---------------------------------------------------------------------------

const LAUNCHERS = [
  { id: 'chat', label: 'Scout', icon: 'S' },
  { id: 'today', label: 'Today', icon: 'T' },
  { id: 'connect', label: 'Connect', icon: 'C' },
  { id: 'mail', label: 'Mail', icon: 'M' },
  { id: 'calendar', label: 'Calendar', icon: 'D' },
  { id: 'netlog', label: 'What Scout Just Did', icon: 'N' },
  { id: 'settings', label: 'Settings', icon: 'G' },
  { id: 'links', label: 'Leaving This Machine', icon: 'L' },
  { id: 'monitor', label: 'Monitor', icon: 'V' },
  { id: 'images', label: 'Make a Picture', icon: 'P' },
];

// The start menu's launcher rows live in their own container so a launcher
// added later (video.js, guarded below) can just append into it without
// disturbing the "PROFILE" section that always stays last.
const startMenuLaunchers = document.createElement('div');

// Adds one icon and one start-menu row for a launcher, callable up front
// for the built-in list above and again later for a module that only
// showed up after a guarded dynamic import (video.js).
function addLauncher(item) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon';
  btn.innerHTML = '<span class="icon-g" aria-hidden="true">' + item.icon + '</span><span>' + item.label + '</span>';
  btn.addEventListener('click', () => windows[item.id] && windows[item.id].open());
  iconsEl.appendChild(btn);

  const row = document.createElement('div');
  row.className = 'smi';
  row.tabIndex = 0;
  row.innerHTML = '<span class="smi-ic" aria-hidden="true">' + item.icon + '</span>' + item.label;
  const activate = () => {
    windows[item.id] && windows[item.id].open();
    setStartMenu(false);
  };
  row.addEventListener('click', activate);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });
  startMenuLaunchers.appendChild(row);
}

function buildDesktopChrome() {
  iconsEl.innerHTML = '';
  startMenuEl.innerHTML = '';
  const heading = document.createElement('div');
  heading.className = 'sm-hd';
  heading.textContent = 'SCOUT';
  startMenuEl.appendChild(heading);
  startMenuEl.appendChild(startMenuLaunchers);

  for (const item of LAUNCHERS) addLauncher(item);

  const other = document.createElement('div');
  other.className = 'sm-hd';
  other.textContent = 'PROFILE';
  startMenuEl.appendChild(other);
  const switchRow = document.createElement('div');
  switchRow.className = 'smi';
  switchRow.tabIndex = 0;
  switchRow.innerHTML = '<span class="smi-ic" aria-hidden="true">P</span>Switch profile';
  const activateSwitch = () => {
    windows.profiles && windows.profiles.open();
    setStartMenu(false);
  };
  switchRow.addEventListener('click', activateSwitch);
  switchRow.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateSwitch();
    }
  });
  startMenuEl.appendChild(switchRow);
}

buildDesktopChrome();

// windows/video.js belongs to the studio milestone and is still being
// finished elsewhere. Load it the same guarded way as lamp.js and voice.js:
// a missing or broken module is logged and otherwise ignored, and its
// launcher only appears once it has actually mounted.
import('./windows/video.js')
  .then((videoWindow) => {
    mount('video', videoWindow);
    addLauncher({ id: 'video', label: 'Video Tools', icon: 'F' });
  })
  .catch((err) => {
    console.warn('Scout: video.js is not available yet', err);
  });

// ---------------------------------------------------------------------------
// Engine pill (from /api/status.engine, kept current by SSE 'engine' events
// once boot.js starts listening; before that it just says "starting").
// ---------------------------------------------------------------------------

function setEnginePill(state) {
  const known = { starting: 'starting', loading: 'loading the model', ready: 'ready', stopped: 'stopped' };
  const label = known[state] || state || 'unknown';
  engineTxtEl.textContent = label;
  engineDotEl.classList.toggle('off', state !== 'ready');
}
api.events.on('engine', (data) => {
  if (data && data.state) setEnginePill(data.state);
});

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

function tickClock() {
  const now = new Date();
  clockTimeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  clockDateEl.textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
tickClock();
setInterval(tickClock, 15000);

// ---------------------------------------------------------------------------
// Boot, then reveal the desktop.
// ---------------------------------------------------------------------------

function finishBoot() {
  bootEl.classList.add('hide');
  desktopEl.hidden = false;
  setTimeout(() => {
    bootEl.hidden = true;
  }, 650);
  if (windows.chat) windows.chat.open();
  if (typeof profilesWindow.checkFirstRun === 'function') {
    profilesWindow.checkFirstRun(host);
  }
}

bootWindow.run(host, { bootEl, onDone: finishBoot });
