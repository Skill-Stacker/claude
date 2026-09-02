// windows/chat.js: the Scout window, the home window, open by default. See
// API.md's "Chat and dispatch" section for the /api/chat and /api/confirm
// contract this file drives.

const MODES = {
  scout: { label: 'Scout', placeholder: 'Ask Scout anything (Enter to send)' },
  homework: {
    label: 'Homework Helper',
    placeholder: "Type the question or topic you're stuck on",
    welcome: "You're in Homework Helper now. Ask about whatever you're stuck on, in your own words.",
  },
  message: {
    label: 'Write a Message',
    placeholder: 'Tell me what you want to say, and any details to include',
    welcome: "You're in Write a Message now. Tell me what you want to say and I'll help you write it.",
  },
  summarize: {
    label: 'Summarize This',
    placeholder: 'Paste the text you want summarized',
    welcome: "You're in Summarize This now. Paste the text below and I'll sum it up.",
  },
  study: {
    label: 'Study Buddy',
    placeholder: 'Tell me what topic you want to be quizzed on',
    welcome: "You're in Study Buddy now. Tell me what topic you want to be quizzed on.",
  },
  story: {
    label: 'Bedtime Story',
    placeholder: 'Tell me a character, animal, or theme',
    welcome: "You're in Bedtime Story now. Tell me a character, animal, or theme and I'll make up a short story.",
  },
};
const MODE_ORDER = ['scout', 'homework', 'message', 'summarize', 'study', 'story'];

const SOURCE_LABEL = { calendar: 'from your calendar', inbox: 'from your inbox', reminders: 'from your reminders' };

function formatAsOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return 'as of ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function mount(host) {
  const win = host.createWindow({ id: 'chat', title: 'Scout', icon: 'S', width: 640, height: 620, left: 100, top: 70 });
  const body = win.body;
  body.classList.add('chat-body');

  // -- mode bar -------------------------------------------------------------
  const modeBar = document.createElement('div');
  modeBar.className = 'mode-bar';
  const modeButtons = {};
  for (const key of MODE_ORDER) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mode-btn';
    btn.textContent = MODES[key].label;
    btn.addEventListener('click', () => setMode(key));
    modeButtons[key] = btn;
    modeBar.appendChild(btn);
  }

  const toolbar = document.createElement('div');
  toolbar.className = 'chat-toolbar';
  const newChatBtn = document.createElement('button');
  newChatBtn.type = 'button';
  newChatBtn.className = 'btn-ghost';
  newChatBtn.textContent = 'New Chat';
  const saveChatsBtn = document.createElement('button');
  saveChatsBtn.type = 'button';
  saveChatsBtn.className = 'btn-ghost';
  saveChatsBtn.textContent = 'Save My Chats';
  toolbar.append(newChatBtn, saveChatsBtn);

  const msgsEl = document.createElement('div');
  msgsEl.className = 'msgs';
  msgsEl.setAttribute('role', 'log');
  msgsEl.setAttribute('aria-live', 'polite');

  const composer = document.createElement('div');
  composer.className = 'composer';
  const input = document.createElement('textarea');
  input.placeholder = MODES.scout.placeholder;
  input.setAttribute('aria-label', 'Message Scout');
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'send';
  sendBtn.textContent = 'Send';
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'send stop';
  stopBtn.textContent = 'Stop';
  stopBtn.hidden = true;
  composer.append(input, sendBtn, stopBtn);

  body.append(modeBar, toolbar, msgsEl, composer);

  let messages = []; // { role: 'user' | 'assistant', content }
  let currentMode = 'scout';
  let currentStream = null;
  let stoppedByUser = false;

  function setMode(key, { silent = false } = {}) {
    if (!MODES[key]) return;
    currentMode = key;
    for (const k of MODE_ORDER) modeButtons[k].classList.toggle('active', k === key);
    messages = [];
    msgsEl.innerHTML = '';
    input.placeholder = MODES[key].placeholder;
    if (!silent) {
      if (key !== 'scout') addSystemNote(MODES[key].welcome || MODES[key].label + ' mode is on.');
      else addSystemNote('New chat. Nothing from before carries over.');
    }
    input.focus();
  }

  newChatBtn.addEventListener('click', () => setMode('scout'));

  // -- rendering --------------------------------------------------------------

  function scrollToEnd() {
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function addSystemNote(text) {
    const el = document.createElement('div');
    el.className = 'msg sys';
    el.textContent = text;
    msgsEl.appendChild(el);
    scrollToEnd();
    return el;
  }

  function addUserBubble(text) {
    const el = document.createElement('div');
    el.className = 'msg me';
    el.textContent = text;
    msgsEl.appendChild(el);
    scrollToEnd();
    return el;
  }

  function addAssistantBubble() {
    const el = document.createElement('div');
    el.className = 'msg ai';
    el.textContent = '';
    msgsEl.appendChild(el);
    scrollToEnd();
    return el;
  }

  function attachMessageActions(bubble) {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg-action-btn';
    copyBtn.textContent = 'Copy';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'msg-action-btn';
    saveBtn.textContent = 'Save';
    const note = document.createElement('span');
    note.className = 'msg-action-note';
    bar.append(copyBtn, saveBtn, note);

    function flash(text) {
      note.textContent = text;
      clearTimeout(flash._t);
      flash._t = setTimeout(() => {
        note.textContent = '';
      }, 2500);
    }
    copyBtn.addEventListener('click', () => {
      const text = bubble.textContent || '';
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => flash('Copied.'), () => flash('Could not copy. Select the text and copy it by hand.'));
      } else {
        flash("Copying isn't available in this browser.");
      }
    });
    saveBtn.addEventListener('click', () => {
      const text = bubble.textContent || '';
      if (!text) return;
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'scout-answer-' + Date.now() + '.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      flash('Saved to your downloads.');
    });
    bubble.insertAdjacentElement('afterend', bar);
  }

  // Rendered the moment a source event arrives, which is usually while
  // "still thinking" is still showing: Scout looked something up before it
  // has anything to say yet, and the chip says so right away.
  function renderSourceChip(source) {
    if (!source) return;
    const chip = document.createElement('span');
    chip.className = 'source-chip';
    const label = SOURCE_LABEL[source.kind] || source.kind || 'a source';
    chip.textContent = label + (source.asOf ? ', ' + formatAsOf(source.asOf) : '');
    msgsEl.appendChild(chip);
    scrollToEnd();
  }

  function renderConfirmCard(data) {
    const card = document.createElement('div');
    card.className = 'confirm-card';
    const sentence = document.createElement('p');
    sentence.textContent = data.sentence;
    card.appendChild(sentence);

    let pinInput = null;
    if (data.details && data.details.needsPin) {
      pinInput = document.createElement('input');
      pinInput.type = 'password';
      pinInput.inputMode = 'numeric';
      pinInput.pattern = '[0-9]*';
      pinInput.maxLength = 8;
      pinInput.placeholder = 'PIN';
      pinInput.className = 'confirm-pin';
      pinInput.setAttribute('aria-label', 'PIN to confirm');
      card.appendChild(pinInput);
    }

    const btnRow = document.createElement('div');
    btnRow.className = 'confirm-btns';
    const yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'btn-primary';
    yesBtn.textContent = 'Yes';
    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'btn-ghost';
    noBtn.textContent = 'No';
    btnRow.append(yesBtn, noBtn);
    card.appendChild(btnRow);

    const resultEl = document.createElement('p');
    resultEl.className = 'confirm-result';
    resultEl.hidden = true;
    card.appendChild(resultEl);

    async function answer(value) {
      yesBtn.disabled = true;
      noBtn.disabled = true;
      if (pinInput) pinInput.disabled = true;
      try {
        const payload = { confirmId: data.confirmId, answer: value };
        if (pinInput && pinInput.value.trim()) payload.pin = pinInput.value.trim();
        const result = await host.api.postJson('/api/confirm', payload);
        resultEl.hidden = false;
        resultEl.textContent = result && result.message ? result.message : (result && result.ok ? 'Done.' : 'Not done.');
        if (result && result.url) {
          window.open(result.url, '_blank', 'noopener');
        }
      } catch (err) {
        resultEl.hidden = false;
        resultEl.textContent = 'Could not reach Scout to finish that. ' + (err.message || '');
      }
      btnRow.hidden = true;
      if (pinInput) pinInput.hidden = true;
    }
    yesBtn.addEventListener('click', () => answer('yes'));
    noBtn.addEventListener('click', () => answer('no'));

    msgsEl.appendChild(card);
    scrollToEnd();
    (pinInput || yesBtn).focus();
  }

  function showFriendlyError(data) {
    const wrap = document.createElement('div');
    wrap.className = 'msg sys friendly-error';
    const p = document.createElement('p');
    p.textContent = (data && data.message) || 'Something went wrong reaching Scout.';
    wrap.appendChild(p);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry-btn';
    retry.textContent = 'Try a shorter question';
    retry.addEventListener('click', () => {
      const last = [...messages].reverse().find((m) => m.role === 'user');
      if (last) submitText(last.content, { retry: true });
    });
    wrap.appendChild(retry);
    msgsEl.appendChild(wrap);
    scrollToEnd();
  }

  // -- thinking indicator -----------------------------------------------------

  function startThinking() {
    const el = document.createElement('div');
    el.className = 'thinking-msg';
    const startedAt = Date.now();
    el.textContent = 'Still thinking, 0 s';
    msgsEl.appendChild(el);
    scrollToEnd();
    const timer = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      el.textContent = 'Still thinking, ' + secs + ' s';
    }, 1000);
    return {
      remove() {
        clearInterval(timer);
        el.remove();
      },
    };
  }

  // -- sending ------------------------------------------------------------

  async function submitText(text, opts = {}) {
    const trimmed = (text || '').trim();
    if (!trimmed || currentStream) return;

    const historySnapshot = messages.slice(-20).map((m) => ({ role: m.role, content: m.content }));
    addUserBubble(trimmed);
    messages.push({ role: 'user', content: trimmed });

    sendBtn.disabled = true;
    stopBtn.hidden = false;
    stoppedByUser = false;
    const thinking = startThinking();

    let assistantBubble = null;
    let acc = '';
    let gotError = false;
    let gotConfirm = false;
    const isVoice = !!opts.voice;

    currentStream = host.api.postSse(
      '/api/chat',
      {
        profileId: host.getProfile() ? host.getProfile().id : null,
        text: trimmed,
        mode: currentMode,
        history: historySnapshot,
        voice: isVoice,
      },
      {
        delta(data) {
          if (!assistantBubble) {
            thinking.remove();
            assistantBubble = addAssistantBubble();
          }
          acc += (data && data.content) || '';
          assistantBubble.textContent = acc;
          scrollToEnd();
        },
        source(data) {
          renderSourceChip(data);
        },
        confirm(data) {
          gotConfirm = true;
          renderConfirmCard(data);
        },
        done() {
          thinking.remove();
          if (acc) {
            messages.push({ role: 'assistant', content: acc });
            if (assistantBubble) attachMessageActions(assistantBubble);
            if (isVoice && host.stickos.voice && typeof host.stickos.voice.speak === 'function') {
              host.stickos.voice.speak(acc);
            }
          } else if (!assistantBubble && !gotError && !gotConfirm) {
            showFriendlyError({ message: 'Scout did not have anything to say back that time. Try again, or ask it a different way.' });
          }
          finishStream();
        },
        error(data) {
          gotError = true;
          thinking.remove();
          showFriendlyError(data);
          finishStream();
        },
        onerror(err) {
          if (stoppedByUser) return;
          gotError = true;
          thinking.remove();
          showFriendlyError({ message: 'Could not reach Scout. ' + (err && err.message ? err.message : '') });
          finishStream();
        },
      },
    );

    function finishStream() {
      currentStream = null;
      sendBtn.disabled = false;
      stopBtn.hidden = true;
    }
  }

  sendBtn.addEventListener('click', () => {
    const text = input.value;
    input.value = '';
    submitText(text);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendBtn.click();
    }
  });
  stopBtn.addEventListener('click', () => {
    if (!currentStream) return;
    stoppedByUser = true;
    currentStream.abort();
    currentStream = null;
    sendBtn.disabled = false;
    stopBtn.hidden = true;
    addSystemNote('Stopped. Ask again whenever you are ready.');
  });

  // -- Save My Chats --------------------------------------------------------

  let chatsDirHandle = null;
  saveChatsBtn.addEventListener('click', async () => {
    const text = messages.map((m) => (m.role === 'user' ? 'You: ' : 'Scout: ') + m.content).join('\n\n');
    if (!text) {
      host.toast('Nothing to save yet.');
      return;
    }
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        if (!chatsDirHandle) chatsDirHandle = await window.showDirectoryPicker({ id: 'stickos-chats' });
        const name = 'chat-' + Date.now() + '.json';
        const fh = await chatsDirHandle.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify({ mode: currentMode, messages, savedAt: new Date().toISOString() }, null, 2));
        await w.close();
        addSystemNote('Saved to the folder you picked.');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        chatsDirHandle = null;
        // fall through to the download fallback below
      }
    }
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scout-chat-' + Date.now() + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    addSystemNote('Saved to your downloads.');
  });

  setMode('scout', { silent: true });
  addSystemNote('Welcome to Scout. Ask anything, or hold the mic button to talk.');

  win.sendVoiceText = function sendVoiceText(text) {
    win.open();
    submitText(text, { voice: true });
  };
  // Used by other windows (Connect's "Try it") to put text into Scout's
  // mouth as if it had been typed, without marking it as spoken.
  win.sendText = function sendText(text) {
    win.open();
    submitText(text, {});
  };

  return win;
}
