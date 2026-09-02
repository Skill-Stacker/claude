// windows/today.js: the daily brief. GET /api/brief -> { greeting, events,
// unread, reminders, asOf }. Field names inside events/reminders are not
// pinned down by API.md beyond the top level, so every reader here falls
// back across the reasonable spellings instead of assuming one.

function pick(obj, keys, fallback) {
  for (const key of keys) {
    if (obj && obj[key] != null && obj[key] !== '') return obj[key];
  }
  return fallback;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function eventText(e) {
  const title = pick(e, ['title', 'summary'], 'Untitled event');
  const start = pick(e, ['start', 'startUtc', 'startTime'], null);
  const time = formatTime(start);
  return time ? title + ', ' + time : title;
}

function reminderText(r) {
  return pick(r, ['text', 'title', 'label'], 'Reminder');
}

export function mount(host) {
  const win = host.createWindow({ id: 'today', title: 'Today', icon: 'T', width: 420, height: 460, left: 140, top: 90 });
  const body = win.body;
  body.classList.add('today-body');

  const greetingEl = document.createElement('h3');
  greetingEl.className = 'today-greeting';
  const asOfEl = document.createElement('p');
  asOfEl.className = 'as-of';
  const readBtn = document.createElement('button');
  readBtn.type = 'button';
  readBtn.className = 'btn-ghost';
  readBtn.textContent = 'Read it to me';

  const eventsHd = document.createElement('h4');
  eventsHd.textContent = 'On your calendar';
  const eventsList = document.createElement('ul');
  eventsList.className = 'today-list lockable';

  const unreadHd = document.createElement('h4');
  unreadHd.textContent = 'In your inbox';
  const unreadEl = document.createElement('p');
  unreadEl.className = 'today-unread lockable';

  const remindersHd = document.createElement('h4');
  remindersHd.textContent = 'Reminders';
  const remindersList = document.createElement('ul');
  remindersList.className = 'today-list';

  body.append(greetingEl, asOfEl, readBtn, eventsHd, eventsList, unreadHd, unreadEl, remindersHd, remindersList);

  let lastBrief = null;

  function render(brief) {
    lastBrief = brief;
    greetingEl.textContent = brief.greeting || 'Here is your day';
    asOfEl.textContent = brief.asOf ? 'As of ' + formatTime(brief.asOf) : '';

    eventsList.innerHTML = '';
    const events = Array.isArray(brief.events) ? brief.events : [];
    if (!events.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing on your calendar today.';
      eventsList.appendChild(li);
    } else {
      for (const e of events) {
        const li = document.createElement('li');
        li.textContent = eventText(e);
        eventsList.appendChild(li);
      }
    }

    const unread = brief.unread;
    if (Array.isArray(unread)) {
      unreadEl.textContent = unread.length ? unread.length + ' unread message' + (unread.length === 1 ? '' : 's') + '.' : 'No unread mail.';
    } else if (typeof unread === 'number') {
      unreadEl.textContent = unread ? unread + ' unread message' + (unread === 1 ? '' : 's') + '.' : 'No unread mail.';
    } else {
      unreadEl.textContent = 'Mail is not connected yet.';
    }

    remindersList.innerHTML = '';
    const reminders = Array.isArray(brief.reminders) ? brief.reminders : [];
    if (!reminders.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No reminders.';
      remindersList.appendChild(li);
    } else {
      for (const r of reminders) {
        const li = document.createElement('li');
        li.textContent = reminderText(r);
        remindersList.appendChild(li);
      }
    }
  }

  async function refresh() {
    const profile = host.getProfile();
    if (!profile) {
      greetingEl.textContent = 'Pick who you are first.';
      asOfEl.textContent = '';
      eventsList.innerHTML = '';
      unreadEl.textContent = '';
      remindersList.innerHTML = '';
      return;
    }
    try {
      const data = await host.api.getJson('/api/brief?profileId=' + encodeURIComponent(profile.id));
      render(data);
    } catch (err) {
      greetingEl.textContent = "Couldn't load today's brief.";
      asOfEl.textContent = err.message || '';
    }
  }

  readBtn.addEventListener('click', () => {
    if (!lastBrief) return;
    if (!host.stickos.voice || typeof host.stickos.voice.speak !== 'function') {
      host.toast('Voice is not ready yet.');
      return;
    }
    const events = Array.isArray(lastBrief.events) ? lastBrief.events : [];
    const parts = [lastBrief.greeting || 'Here is your day.'];
    if (events.length) parts.push(events.map(eventText).join('. '));
    else parts.push('Nothing on your calendar today.');
    host.stickos.voice.speak(parts.join(' '));
  });

  const originalOpen = win.open;
  win.open = function open() {
    originalOpen();
    refresh();
  };
  host.onProfileChange(() => {
    if (win.isOpen()) refresh();
  });

  return win;
}
