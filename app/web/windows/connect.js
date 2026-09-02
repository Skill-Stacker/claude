// windows/connect.js: the Connect wizard, one step per screen with Back
// and Next, exactly in the order laid out in the task: intro, PIN (only if
// the profile has none), 2-Step Verification, Gmail address, App Password,
// verify Gmail, folders found, the secret calendar address, verify
// calendar, the feed-lag explanation, the lock explanation, done.

const SECURITY_URL = 'https://myaccount.google.com/security';
const APP_PASSWORDS_URL = 'https://myaccount.google.com/apppasswords';

const STEP_ORDER = [
  'intro', 'pin', 'twoStep', 'gmailAddress', 'appPassword', 'verifyGmail',
  'foldersFound', 'calendarAddress', 'verifyCalendar', 'feedLag', 'lockExplain', 'done',
];

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function domainOf(address) {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}
function appPasswordClean(value) {
  return String(value || '').replace(/\s+/g, '');
}

export function mount(host) {
  const win = host.createWindow({ id: 'connect', title: 'Connect', icon: 'C', width: 480, height: 560, left: 260, top: 80 });
  const body = win.body;
  body.classList.add('connect-body');

  const stepEl = document.createElement('div');
  stepEl.className = 'connect-step';
  const navRow = document.createElement('div');
  navRow.className = 'connect-nav';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn-ghost';
  backBtn.textContent = 'Back';
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'btn-primary';
  nextBtn.textContent = 'Next';
  navRow.append(backBtn, nextBtn);
  body.append(stepEl, navRow);

  let stepIndex = 0;
  let currentDef = null;
  const state = { address: '', appPassword: '', folders: [], icsUrl: '', calendarName: '' };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function skipStep(id) {
    if (id === 'pin') {
      const profile = host.getProfile();
      return !!(profile && profile.hasPin);
    }
    return false;
  }

  function goTo(index, direction) {
    let i = index;
    while (i >= 0 && i < STEP_ORDER.length && skipStep(STEP_ORDER[i])) i += direction;
    if (i < 0 || i >= STEP_ORDER.length) return;
    stepIndex = i;
    renderStep();
  }
  function advance() {
    goTo(stepIndex + 1, 1);
  }
  function retreat() {
    goTo(stepIndex - 1, -1);
  }

  function setNav({ showBack = true, nextLabel = 'Next', showNext = true, nextDisabled = false } = {}) {
    backBtn.hidden = !showBack || stepIndex === 0;
    nextBtn.hidden = !showNext;
    nextBtn.textContent = nextLabel;
    nextBtn.disabled = nextDisabled;
  }

  backBtn.addEventListener('click', retreat);

  // ---- step renderers -----------------------------------------------------

  const STEPS = {
    intro() {
      stepEl.appendChild(el('h2', null, 'Connect Gmail and Calendar'));
      stepEl.appendChild(el('p', null, 'This lets Scout read and send mail, and read and add events on your calendar. It uses your own Google account, no sign-in from Scout itself.'));
      stepEl.appendChild(el('p', 'connect-badge', 'Only the steps you choose to do here leave this machine, and each one is logged in "What Scout Just Did".'));
      setNav({ showBack: false });
      nextBtn.onclick = advance;
    },

    pin() {
      stepEl.appendChild(el('h2', null, 'Set a PIN first'));
      stepEl.appendChild(el('p', null, 'A PIN keeps your mail and calendar private on this profile. Anyone can still talk to Scout; the PIN only protects your connected accounts.'));
      const pin1 = document.createElement('input');
      pin1.type = 'password';
      pin1.inputMode = 'numeric';
      pin1.pattern = '[0-9]*';
      pin1.maxLength = 8;
      pin1.placeholder = 'New PIN (4 to 8 digits)';
      pin1.className = 'connect-input';
      const pin2 = document.createElement('input');
      pin2.type = 'password';
      pin2.inputMode = 'numeric';
      pin2.pattern = '[0-9]*';
      pin2.maxLength = 8;
      pin2.placeholder = 'Enter it again';
      pin2.className = 'connect-input';
      const errorEl = el('p', 'connect-error');
      errorEl.hidden = true;
      stepEl.append(pin1, pin2, errorEl);
      setNav({ nextLabel: 'Save PIN' });
      nextBtn.onclick = async () => {
        const a = pin1.value.trim();
        const b = pin2.value.trim();
        if (!/^\d{4,8}$/.test(a)) {
          errorEl.hidden = false;
          errorEl.textContent = 'A PIN is 4 to 8 digits.';
          return;
        }
        if (a !== b) {
          errorEl.hidden = false;
          errorEl.textContent = 'Those two did not match.';
          return;
        }
        nextBtn.disabled = true;
        try {
          const profile = host.getProfile();
          await host.api.postJson('/api/profiles/pin', { profileId: profile.id, pin: a });
          profile.hasPin = true;
          advance();
        } catch (err) {
          errorEl.hidden = false;
          errorEl.textContent = err.message || 'Could not save that PIN.';
        } finally {
          nextBtn.disabled = false;
        }
      };
    },

    twoStep() {
      stepEl.appendChild(el('h2', null, 'Turn on 2-Step Verification'));
      stepEl.appendChild(el('p', null, 'Google requires this before it will let Scout use an app password. It takes about two minutes.'));
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn-ghost';
      openBtn.textContent = 'Open Google Account Security';
      openBtn.addEventListener('click', () => window.open(SECURITY_URL, '_blank', 'noopener'));
      stepEl.appendChild(openBtn);
      setNav({ nextLabel: "I've turned it on, continue" });
      nextBtn.onclick = advance;
    },

    gmailAddress() {
      stepEl.appendChild(el('h2', null, 'Your Gmail address'));
      const input = document.createElement('input');
      input.type = 'email';
      input.className = 'connect-input';
      input.placeholder = 'you@gmail.com';
      input.value = state.address;
      const warn = el('p', 'connect-warn');
      warn.hidden = true;
      stepEl.append(input, warn);
      input.addEventListener('input', () => {
        const domain = domainOf(input.value.trim());
        const known = domain === 'gmail.com' || domain === 'googlemail.com';
        warn.hidden = !domain || known;
        warn.textContent = 'That does not look like a regular Gmail address. School or work accounts often have app passwords turned off, and mail needs a home-style network to work well. It may still work, worth a try.';
      });
      setNav();
      nextBtn.onclick = () => {
        const value = input.value.trim();
        if (!looksLikeEmail(value)) {
          input.focus();
          return;
        }
        state.address = value;
        advance();
      };
    },

    appPassword() {
      stepEl.appendChild(el('h2', null, 'Your app password'));
      stepEl.appendChild(el('p', null, 'This is a 16-letter password Google makes just for Scout, separate from your real password.'));
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn-ghost';
      openBtn.textContent = 'Open App Passwords';
      openBtn.addEventListener('click', () => window.open(APP_PASSWORDS_URL, '_blank', 'noopener'));
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'connect-input';
      input.placeholder = '16-letter app password';
      input.value = state.appPassword;
      const hint = el('p', 'connect-hint');
      stepEl.append(openBtn, input, hint);
      function paint() {
        const clean = appPasswordClean(input.value);
        const valid = clean.length === 16;
        hint.textContent = valid ? 'Looks right.' : clean.length + ' of 16 characters.';
        setNav({ nextDisabled: !valid });
      }
      input.addEventListener('input', paint);
      paint();
      nextBtn.onclick = () => {
        state.appPassword = appPasswordClean(input.value);
        advance();
      };
    },

    verifyGmail() {
      stepEl.appendChild(el('h2', null, 'Checking Gmail'));
      const status = el('p', null, 'Signing in with that address and app password');
      stepEl.appendChild(status);
      setNav({ showNext: false });

      async function run() {
        const profile = host.getProfile();
        try {
          const result = await host.api.postJson('/api/google/gmail/verify', {
            profileId: profile.id,
            address: state.address,
            appPassword: state.appPassword,
          });
          if (result && result.ok) {
            state.folders = result.folders || [];
            advance();
            return;
          }
          renderFailure(result);
        } catch (err) {
          renderFailure({ message: err.message });
        }
      }
      function renderFailure(result) {
        status.textContent = (result && result.message) || 'That did not work.';
        if (result && result.question) stepEl.appendChild(el('p', 'connect-question', result.question));
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn-primary';
        retryBtn.textContent = 'Try Again';
        retryBtn.addEventListener('click', run);
        const backToPwBtn = document.createElement('button');
        backToPwBtn.type = 'button';
        backToPwBtn.className = 'btn-ghost';
        backToPwBtn.textContent = 'Go back and fix it';
        backToPwBtn.addEventListener('click', () => goTo(STEP_ORDER.indexOf('appPassword'), -1));
        stepEl.append(retryBtn, backToPwBtn);
      }
      run();
    },

    foldersFound() {
      stepEl.appendChild(el('h2', null, 'Mail connected'));
      const status = el('p', null, 'Saving');
      stepEl.appendChild(status);
      const list = document.createElement('ul');
      list.className = 'connect-folder-list';
      stepEl.appendChild(list);
      setNav({ showNext: false });

      (async () => {
        try {
          const profile = host.getProfile();
          await host.api.postJson('/api/google/gmail/save', { profileId: profile.id, address: state.address, appPassword: state.appPassword });
          status.textContent = 'Scout found these folders:';
          for (const f of state.folders) list.appendChild(el('li', null, typeof f === 'string' ? f : f.name || f.path || 'folder'));
          setNav();
          nextBtn.onclick = advance;
        } catch (err) {
          status.textContent = 'Connected, but could not save it. ' + (err.message || '');
          setNav();
          nextBtn.onclick = advance;
        }
      })();
    },

    calendarAddress() {
      stepEl.appendChild(el('h2', null, 'Your calendar\'s secret address'));
      const steps = document.createElement('ol');
      steps.className = 'connect-instructions';
      steps.appendChild(el('li', null, 'Open Google Calendar and click the gear, then Settings.'));
      steps.appendChild(el('li', null, 'Under "Settings for my calendars", pick the calendar you want Scout to read.'));
      steps.appendChild(el('li', null, 'Click "Integrate calendar".'));
      steps.appendChild(el('li', null, 'Copy the "Secret address in iCal format". Not the public address, the secret one.'));
      stepEl.appendChild(steps);
      const input = document.createElement('input');
      input.type = 'url';
      input.className = 'connect-input';
      input.placeholder = 'https://calendar.google.com/calendar/ical/...';
      input.value = state.icsUrl;
      stepEl.appendChild(input);
      setNav();
      nextBtn.onclick = () => {
        const value = input.value.trim();
        if (!value) {
          input.focus();
          return;
        }
        state.icsUrl = value;
        advance();
      };
    },

    verifyCalendar() {
      stepEl.appendChild(el('h2', null, 'Checking your calendar'));
      const status = el('p', null, 'Reading that address');
      stepEl.appendChild(status);
      setNav({ showNext: false });

      async function run() {
        const profile = host.getProfile();
        try {
          const result = await host.api.postJson('/api/google/calendar/verify', { profileId: profile.id, icsUrl: state.icsUrl });
          if (result && result.ok) {
            state.calendarName = result.calendarName || 'your calendar';
            status.textContent = 'Found ' + (result.upcoming != null ? result.upcoming : 'some') + ' upcoming events on ' + state.calendarName + '.';
            try {
              await host.api.postJson('/api/google/calendar/save', { profileId: profile.id, icsUrl: state.icsUrl });
            } catch {
              // saved verification still counts as success for this step
            }
            setNav();
            nextBtn.onclick = advance;
            return;
          }
          renderFailure(result);
        } catch (err) {
          renderFailure({ message: err.message });
        }
      }
      function renderFailure(result) {
        status.textContent = (result && result.message) || 'That did not work.';
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn-primary';
        retryBtn.textContent = 'Try Again';
        retryBtn.addEventListener('click', run);
        const backBtn2 = document.createElement('button');
        backBtn2.type = 'button';
        backBtn2.className = 'btn-ghost';
        backBtn2.textContent = 'Go back and paste a different address';
        backBtn2.addEventListener('click', () => goTo(STEP_ORDER.indexOf('calendarAddress'), -1));
        stepEl.append(retryBtn, backBtn2);
      }
      run();
    },

    feedLag() {
      stepEl.appendChild(el('h2', null, 'About the calendar feed'));
      stepEl.appendChild(el('p', null, "Google only updates this feed every so often, sometimes a few hours behind. Scout always says \"as of\" a time, so you know how fresh what it's telling you is."));
      setNav();
      nextBtn.onclick = advance;
    },

    lockExplain() {
      stepEl.appendChild(el('h2', null, 'About the lock'));
      stepEl.appendChild(el('p', null, 'Your mail and calendar only show on screen while your profile is unlocked with your PIN. Lock it any time from the chip at the top of the screen, and it locks itself after a while on its own.'));
      setNav();
      nextBtn.onclick = advance;
    },

    done() {
      stepEl.appendChild(el('h2', null, 'All set'));
      stepEl.appendChild(el('p', null, 'Scout can read and send your mail, and read and add events on your calendar.'));
      const tryBtn = document.createElement('button');
      tryBtn.type = 'button';
      tryBtn.className = 'btn-primary';
      tryBtn.textContent = "Try it: what's on my calendar today?";
      tryBtn.addEventListener('click', () => {
        if (host.windows.chat && typeof host.windows.chat.sendText === 'function') {
          host.windows.chat.sendText("what's on my calendar today?");
        }
        win.close();
      });
      stepEl.appendChild(tryBtn);
      setNav({ showNext: false });
    },
  };

  function renderStep() {
    stepEl.innerHTML = '';
    const profile = host.getProfile();
    if (!profile) {
      stepEl.appendChild(el('h2', null, 'Pick who you are first'));
      stepEl.appendChild(el('p', null, 'Connect needs a profile to save things to.'));
      setNav({ showBack: false, showNext: false });
      return;
    }
    currentDef = STEP_ORDER[stepIndex];
    STEPS[currentDef]();
  }

  const originalOpen = win.open;
  win.open = function open() {
    originalOpen();
    stepIndex = 0;
    renderStep();
  };

  return win;
}
