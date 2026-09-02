// The voice loop: hold-to-talk mic capture over WS /ws/mic, and streamed
// TTS playback over POST /api/tts. See app/API.md for the exact message
// shapes. This file implements its own small SSE-over-fetch parser for
// /api/tts (rather than importing the other agent's api.js) and its own
// WebSocket client for /ws/mic, per this module's brief.
//
// Attaches to window.StickOS once it appears (app.js and this module load
// independently) and never throws if it never shows up. Nothing at module
// load time touches window or document; the self-attach block at the
// bottom is guarded and polls briefly.

import { createPlayer } from './audio-player.js';

const TAP_MS = 250; // a press shorter than this is a tap, not a hold
const WS_RECONNECT_DELAYS = [1000, 2000, 4000];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state = 'idle'; // 'idle' | 'listening' | 'thinking' | 'speaking'

let ws = null;
let connectingPromise = null;
let wsReconnectAttempt = 0;
let wsReconnectTimer = null;

let audioContext = null;
let player = null;
let workletReady = false;

let micStream = null;
let sourceNode = null;
let workletNode = null;
let silentGain = null;

let holdActive = false;
let pressStartedAt = 0;

let ttsAbortController = null;
let streamDone = true;

let permissionDenied = false;

let noteEl = null;
let bannerEl = null;
let stopBtn = null;

// ---------------------------------------------------------------------------
// DOM helpers (all optional-chained: the page shape is not ours to assume)
// ---------------------------------------------------------------------------

function setStatus(text) {
  const el = document.getElementById('voice-status');
  if (el) el.textContent = text || '';
}

function setLevel(v) {
  if (window.StickOS && window.StickOS.lamp && typeof window.StickOS.lamp.setLevel === 'function') {
    window.StickOS.lamp.setLevel(v);
  }
}

function currentProfileId() {
  if (window.StickOS && window.StickOS.profile && window.StickOS.profile.id != null) {
    return window.StickOS.profile.id;
  }
  return 1;
}

function toast(message) {
  if (window.StickOS && typeof window.StickOS.toast === 'function') {
    try {
      window.StickOS.toast(message);
    } catch {
      // page's problem, not ours
    }
  }
}

function showStopButton(show) {
  if (stopBtn) stopBtn.classList.toggle('stickos-hidden', !show);
}

function setState(next) {
  state = next;
  if (window.StickOS && typeof window.StickOS.setMood === 'function') {
    try {
      window.StickOS.setMood(next);
    } catch {
      // page's problem, not ours
    }
  }
  showStopButton(next === 'thinking' || next === 'speaking');
}

function isTextInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  return !!el.isContentEditable;
}

// ---------------------------------------------------------------------------
// Injected UI: a prompt-permission note, a denied banner with per-browser
// unblock steps, and a Stop control. app.js owns #mic and #voice-status;
// everything else here is ours to add.
// ---------------------------------------------------------------------------

function injectStyles() {
  if (document.getElementById('stickos-voice-style')) return;
  const style = document.createElement('style');
  style.id = 'stickos-voice-style';
  style.textContent = `
    .stickos-mic-note {
      position: fixed; left: 50%; bottom: 6.5rem; transform: translateX(-50%);
      font-size: 0.8rem; color: #9aa4b8; background: rgba(16, 19, 26, 0.7);
      padding: 0.3rem 0.7rem; border-radius: 999px; pointer-events: none; z-index: 40;
    }
    .stickos-mic-banner {
      position: fixed; top: 1rem; left: 50%; transform: translateX(-50%);
      max-width: 26rem; width: calc(100% - 2rem);
      background: rgba(30, 18, 18, 0.92); border: 1px solid rgba(255, 120, 120, 0.4);
      border-radius: 0.75rem; padding: 1rem 1.25rem; color: #f3e7e7;
      z-index: 60; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    }
    .stickos-mic-banner h3 { margin: 0 0 0.4rem; font-size: 1rem; }
    .stickos-mic-banner p { margin: 0 0 0.4rem; font-size: 0.85rem; }
    .stickos-mic-banner ol { margin: 0.4rem 0; padding-left: 1.2rem; font-size: 0.85rem; }
    .stickos-mic-banner li { margin: 0.15rem 0; }
    .stickos-banner-actions { display: flex; gap: 0.5rem; margin-top: 0.6rem; }
    .stickos-mic-banner button {
      font: inherit; padding: 0.4rem 0.8rem; border-radius: 0.5rem;
      border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(255, 255, 255, 0.08);
      color: inherit; cursor: pointer;
    }
    .stickos-stop-btn {
      position: fixed; left: 50%; bottom: 2.2rem; transform: translate(4.4rem, 0);
      font-size: 0.8rem; padding: 0.4rem 0.9rem; border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(16, 19, 26, 0.85);
      color: #e7ebf3; cursor: pointer; z-index: 45;
    }
    .stickos-hidden { display: none !important; }
  `;
  document.head.appendChild(style);
}

function ensureUi() {
  injectStyles();
  if (!noteEl) {
    noteEl = document.createElement('div');
    noteEl.className = 'stickos-mic-note stickos-hidden';
    noteEl.textContent = 'Scout needs the microphone. Your browser will ask once.';
    document.body.appendChild(noteEl);
  }
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.className = 'stickos-mic-banner stickos-hidden';
    bannerEl.setAttribute('role', 'alert');
    document.body.appendChild(bannerEl);
  }
  if (!stopBtn) {
    stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'stickos-stop-btn stickos-hidden';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', cancel);
    document.body.appendChild(stopBtn);
  }
}

function showPromptNote(show) {
  if (noteEl) noteEl.classList.toggle('stickos-hidden', !show);
}

const UNBLOCK_STEPS = {
  'windows-chrome': [
    'Click the lock icon at the left of the address bar.',
    'Set Microphone to Allow.',
    'Reload this page.',
  ],
  'windows-edge': [
    'Click the lock icon at the left of the address bar.',
    'Open Permissions for this site.',
    'Set Microphone to Allow.',
    'Reload this page.',
  ],
  'mac-chrome': [
    'Click the lock icon at the left of the address bar.',
    'Set Microphone to Allow.',
    'Open System Settings, then Privacy and Security, then Microphone, and turn Chrome on.',
    'Reload this page.',
  ],
  'mac-safari': [
    'Open the Safari menu and choose Settings for This Website.',
    'Set Microphone to Allow.',
    'Open System Settings, then Privacy and Security, then Microphone, and turn Safari on.',
    'Reload this page.',
  ],
  generic: [
    'Open this browser\'s site settings for this page.',
    'Set Microphone to Allow.',
    'Reload this page.',
  ],
};

function detectPlatform() {
  const ua = navigator.userAgent || '';
  const isMac = /Macintosh|Mac OS X/.test(ua);
  const isWindows = /Windows/.test(ua);
  const isEdge = /Edg\//.test(ua);
  const isChrome = /Chrome\//.test(ua) && !isEdge;
  const isSafari = /Safari\//.test(ua) && !/Chrome\//.test(ua) && !isEdge;
  if (isWindows && isEdge) return 'windows-edge';
  if (isWindows && isChrome) return 'windows-chrome';
  if (isMac && isChrome) return 'mac-chrome';
  if (isMac && isSafari) return 'mac-safari';
  return 'generic';
}

function focusChatInput() {
  const candidate = document.querySelector('#chat-input, [data-chat-input], textarea#chat, input#chat');
  if (candidate && typeof candidate.focus === 'function') {
    candidate.focus();
  } else {
    toast('Type your message in the chat window.');
  }
}

function renderDeniedBanner() {
  const steps = UNBLOCK_STEPS[detectPlatform()] || UNBLOCK_STEPS.generic;
  bannerEl.innerHTML = '';

  const h = document.createElement('h3');
  h.textContent = 'Scout cannot hear you';
  const p = document.createElement('p');
  p.textContent = 'The microphone is blocked for this page. Turn it back on, or type instead.';
  const ol = document.createElement('ol');
  for (const step of steps) {
    const li = document.createElement('li');
    li.textContent = step;
    ol.appendChild(li);
  }
  const actions = document.createElement('div');
  actions.className = 'stickos-banner-actions';
  const typeBtn = document.createElement('button');
  typeBtn.type = 'button';
  typeBtn.textContent = 'Type instead';
  typeBtn.addEventListener('click', focusChatInput);
  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', () => showDeniedBanner(false));
  actions.append(typeBtn, dismissBtn);

  bannerEl.append(h, p, ol, actions);
}

function showDeniedBanner(show) {
  if (!bannerEl) return;
  if (show) renderDeniedBanner();
  bannerEl.classList.toggle('stickos-hidden', !show);
}

// ---------------------------------------------------------------------------
// Permission check: granted proceeds silently, prompt shows a note and
// waits for the first press, denied shows the banner. Re-checked whenever
// the tab becomes visible again, since the browser's own permission UI
// lives outside the page.
// ---------------------------------------------------------------------------

async function checkMicPermission() {
  if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return;
  let status;
  try {
    status = await navigator.permissions.query({ name: 'microphone' });
  } catch {
    return; // not supported (Safari, some others): fall through to prompt-on-first-press
  }
  applyPermissionState(status.state);
  status.onchange = () => applyPermissionState(status.state);
}

function applyPermissionState(permState) {
  if (permState === 'denied') {
    permissionDenied = true;
    showDeniedBanner(true);
    showPromptNote(false);
  } else if (permState === 'prompt') {
    permissionDenied = false;
    showDeniedBanner(false);
    showPromptNote(true);
  } else {
    permissionDenied = false;
    showDeniedBanner(false);
    showPromptNote(false);
  }
}

function handleMicError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    permissionDenied = true;
    showDeniedBanner(true);
  } else if (name === 'NotFoundError') {
    setStatus('No microphone found.');
  } else {
    setStatus('Could not use the microphone.');
  }
  toast('Microphone problem: ' + (name || 'unknown'));
}

// ---------------------------------------------------------------------------
// Audio graph: mic -> worklet (downsample to 16kHz PCM16) -> a zero-gain
// node into destination, so the graph keeps pulling the worklet without
// ever being audible. Playback uses a separate player built on the same
// AudioContext.
// ---------------------------------------------------------------------------

function ensureAudioContext() {
  if (!audioContext) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioContext = new Ctor();
    player = createPlayer(audioContext);
    player.onEnded(onPlaybackEnded);
    if (window.StickOS && window.StickOS.lamp && typeof window.StickOS.lamp.attachAnalyser === 'function') {
      window.StickOS.lamp.attachAnalyser(player.analyser);
    }
  }
  return audioContext;
}

async function ensureAudioGraph(stream) {
  const ctx = ensureAudioContext();
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      // needs a user gesture; the mic press that got us here should count as one,
      // but if it doesn't, we retry resume() on the next press
    }
  }
  if (!workletReady) {
    await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    workletReady = true;
  }
  sourceNode = ctx.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(ctx, 'pcm-downsampler', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  workletNode.port.onmessage = (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'chunk') return;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg.buffer);
    setLevel(msg.level);
  };
  // Silence in, silence out (the worklet never writes to its output), but
  // routing through an explicit zero-gain node keeps that guaranteed even
  // if that ever changes, and keeps the graph "live" so process() keeps
  // being called.
  silentGain = ctx.createGain();
  silentGain.gain.value = 0;
  sourceNode.connect(workletNode);
  workletNode.connect(silentGain);
  silentGain.connect(ctx.destination);
}

function teardownAudioGraph() {
  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch {
      /* already gone */
    }
    sourceNode = null;
  }
  if (workletNode) {
    try {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    } catch {
      /* already gone */
    }
    workletNode = null;
  }
  if (silentGain) {
    try {
      silentGain.disconnect();
    } catch {
      /* already gone */
    }
    silentGain = null;
  }
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop();
    micStream = null;
  }
}

// ---------------------------------------------------------------------------
// WS /ws/mic client
// ---------------------------------------------------------------------------

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/mic`;
}

function sendWs(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket is on its way down; the close handler will clean up */
    }
  }
}

function openSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  if (connectingPromise) return connectingPromise;

  connectingPromise = new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(wsUrl());
    socket.binaryType = 'arraybuffer';
    let settled = false;

    socket.onopen = () => {
      socket.send(JSON.stringify({ token: window.STICKOS_TOKEN || '' }));
      wsReconnectAttempt = 0;
      ws = socket;
      settled = true;
      resolvePromise(socket);
    };
    socket.onmessage = handleWsMessage;
    socket.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error('mic socket error'));
      }
    };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      if (!settled) {
        settled = true;
        reject(new Error('mic socket closed before it opened'));
      }
      scheduleReconnect();
    };
  }).finally(() => {
    connectingPromise = null;
  });

  return connectingPromise;
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  const delay = WS_RECONNECT_DELAYS[Math.min(wsReconnectAttempt, WS_RECONNECT_DELAYS.length - 1)];
  wsReconnectAttempt += 1;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    openSocket().catch(() => {
      // background reconnect; a held mic will surface its own error, an
      // idle page just quietly keeps trying
    });
  }, delay);
}

function handleWsMessage(event) {
  if (typeof event.data !== 'string') return; // binary frames only ever flow client -> server here
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  if (msg.type === 'partial') {
    setStatus(msg.text || '');
  } else if (msg.type === 'final') {
    onFinal(msg.text || '');
  } else if (msg.type === 'error') {
    onWsError(msg.message || 'Voice had a problem.');
  }
}

function onWsError(message) {
  teardownAudioGraph();
  holdActive = false;
  setStatus(message);
  toast(message);
  setState('idle');
}

function onFinal(text) {
  setStatus(text ? `"${text}"` : '');
  if (window.StickOS && window.StickOS.bus && typeof window.StickOS.bus.emit === 'function') {
    window.StickOS.bus.emit('transcript', text);
  }
  if (window.StickOS && typeof window.StickOS.say === 'function') {
    try {
      window.StickOS.say(text);
    } catch {
      // page's problem, not ours
    }
  }
}

// ---------------------------------------------------------------------------
// Hold-to-talk
// ---------------------------------------------------------------------------

async function startHold() {
  if (state === 'thinking') {
    // a second tap while Scout is thinking cancels the turn, per spec
    cancel();
    return;
  }
  if (holdActive) return;
  if (permissionDenied) {
    showDeniedBanner(true);
    return;
  }

  holdActive = true;
  pressStartedAt = performance.now();

  stop(); // barge-in: stop any TTS playback and any in-flight speech request
  setState('listening');
  setStatus('Listening...');

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    holdActive = false;
    setState('idle');
    handleMicError(err);
    return;
  }

  try {
    await ensureAudioGraph(micStream);
    await openSocket();
    sendWs({ type: 'start', sampleRate: 16000, profileId: currentProfileId() });
  } catch {
    teardownAudioGraph();
    holdActive = false;
    setState('idle');
    setStatus('Could not reach Scout. Try again.');
  }
}

function stopHold() {
  if (!holdActive) return;
  holdActive = false;
  const heldMs = performance.now() - pressStartedAt;
  teardownAudioGraph();

  if (heldMs < TAP_MS) {
    sendWs({ type: 'cancel' });
    setState('idle');
    setStatus('Hold to talk');
    setTimeout(() => setStatus(''), 1600);
    return;
  }

  sendWs({ type: 'stop' });
  setState('thinking');
  setStatus('Thinking...');
}

function cancel() {
  if (state === 'listening') teardownAudioGraph();
  if (state === 'listening' || state === 'thinking') sendWs({ type: 'cancel' });
  holdActive = false;
  stop();
  setStatus('');
  setState('idle');
}

// ---------------------------------------------------------------------------
// speak(): POST /api/tts, parse its SSE reply by hand, queue each WAV chunk
// gap-free on the player.
// ---------------------------------------------------------------------------

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Parses complete `event: x\ndata: y\n\n` blocks out of `buffer` and
// dispatches each; returns the unconsumed remainder for the next read.
async function consumeSseBuffer(buffer) {
  let rest = buffer;
  for (;;) {
    const sep = rest.indexOf('\n\n');
    if (sep < 0) break;
    const block = rest.slice(0, sep);
    rest = rest.slice(sep + 2);

    let eventName = 'message';
    const dataLines = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith(':')) continue; // comment / heartbeat
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) continue;

    let data;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      continue;
    }
    await handleTtsEvent(eventName, data);
  }
  return rest;
}

async function handleTtsEvent(eventName, data) {
  if (eventName === 'chunk' && data && typeof data.wavBase64 === 'string') {
    try {
      await player.enqueue(base64ToArrayBuffer(data.wavBase64));
    } catch {
      // one bad chunk should not stop the rest of the sentence stream
    }
  } else if (eventName === 'error') {
    setStatus((data && data.message) || 'Speech had a problem.');
  }
  // 'done' needs no handling of its own: the server closes the response
  // right after sending it, so the reader loop below ending is just as
  // reliable a signal that nothing more is coming.
}

async function speak(text) {
  if (!text) return;
  stop();
  const ctx = ensureAudioContext();
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      /* needs a gesture; the next mic press will retry it */
    }
  }
  player.reset();
  streamDone = false;
  ttsAbortController = new AbortController();
  setState('speaking');
  setStatus('Speaking...');

  let res;
  try {
    res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-stickos-token': window.STICKOS_TOKEN || '' },
      body: JSON.stringify({ text, profileId: currentProfileId() }),
      signal: ttsAbortController.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    setStatus('Could not reach Scout for speech.');
    setState('idle');
    return;
  }

  if (!res.ok || !res.body) {
    setStatus('Scout could not speak that.');
    setState('idle');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = await consumeSseBuffer(buffer);
    }
  } catch (err) {
    if (err && err.name !== 'AbortError') setStatus('Speech stopped early.');
  }

  streamDone = true;
  if (player && !player.isActive()) {
    setState('idle');
    setStatus('');
  }
}

function onPlaybackEnded() {
  if (streamDone) {
    setState('idle');
    setStatus('');
  }
}

function stop() {
  if (ttsAbortController) {
    try {
      ttsAbortController.abort();
    } catch {
      /* already done */
    }
    ttsAbortController = null;
  }
  if (player) player.stop();
  streamDone = true;
}

// ---------------------------------------------------------------------------
// Wiring: app.js's registerVoice already drives startHold/stopHold from the
// mic button (mousedown/touchstart/mouseup/touchend, plus Space/Enter when
// the button itself is focused). We add the parts that is not: the space
// bar anywhere focus is not in a text field, and Escape while mid-turn.
// Both call the same startHold/stopHold/cancel, which are idempotent, so
// there is no double-handling even when both paths fire for one press.
// ---------------------------------------------------------------------------

function onKeyDown(event) {
  if (event.code === 'Space' && !isTextInputFocused() && !event.repeat) {
    event.preventDefault();
    startHold();
  } else if (event.key === 'Escape' && (state === 'listening' || state === 'thinking')) {
    event.preventDefault();
    cancel();
  }
}

function onKeyUp(event) {
  if (event.code === 'Space' && !isTextInputFocused()) {
    event.preventDefault();
    stopHold();
  }
}

function init(StickOS) {
  ensureUi();
  checkMicPermission();

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkMicPermission();
  });
  window.addEventListener('blur', () => {
    if (holdActive) cancel();
  });

  StickOS.registerVoice({ startHold, stopHold, cancel, speak, stop });
  StickOS.voice = StickOS.voice || {};
  StickOS.voice.speak = speak;
  StickOS.voice.stop = stop;
  Object.defineProperty(StickOS.voice, 'state', { get: () => state, configurable: true });
}

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
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => init(StickOS), { once: true });
    } else {
      init(StickOS);
    }
  });
}
