// windows/calendar.js: a read-only week list. GET /api/calendar/events;
// "Check now" triggers POST /api/google/sync the same way mail.js does.

function pick(obj, keys, fallback) {
  for (const key of keys) {
    if (obj && obj[key] != null && obj[key] !== '') return obj[key];
  }
  return fallback;
}

function startOfDay(d) {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayKey(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString();
}

function dayHeading(dateStr) {
  const d = new Date(dateStr);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

export function mount(host) {
  const win = host.createWindow({ id: 'calendar', title: 'Calendar', icon: 'D', width: 440, height: 520, left: 180, top: 110 });
  const body = win.body;
  body.classList.add('calendar-body');

  const header = document.createElement('div');
  header.className = 'list-header';
  const asOfEl = document.createElement('span');
  asOfEl.className = 'as-of';
  const checkBtn = document.createElement('button');
  checkBtn.type = 'button';
  checkBtn.className = 'btn-ghost';
  checkBtn.textContent = 'Check now';
  header.append(asOfEl, checkBtn);

  const listEl = document.createElement('div');
  listEl.className = 'week-list lockable';

  const link = document.createElement('a');
  link.href = 'https://calendar.google.com/';
  link.target = '_blank';
  link.rel = 'noopener';
  link.className = 'leaves-link';
  link.textContent = 'Open Google Calendar (leaves this machine)';

  body.append(header, listEl, link);

  function render(data) {
    asOfEl.textContent = data.asOf ? 'As of ' + formatTime(data.asOf) : '';
    listEl.innerHTML = '';
    const events = Array.isArray(data.events) ? data.events : [];
    if (!events.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Nothing on the calendar this week.';
      listEl.appendChild(p);
      return;
    }
    const byDay = new Map();
    for (const e of events) {
      const start = pick(e, ['start', 'startUtc', 'startTime'], null);
      const key = dayKey(start) || 'unknown';
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    }
    for (const [key, dayEvents] of byDay) {
      const group = document.createElement('div');
      group.className = 'week-day';
      const h = document.createElement('h4');
      h.textContent = key === 'unknown' ? 'Date unknown' : dayHeading(key);
      group.appendChild(h);
      const ul = document.createElement('ul');
      for (const e of dayEvents) {
        const li = document.createElement('li');
        const title = pick(e, ['title', 'summary'], 'Untitled event');
        const start = pick(e, ['start', 'startUtc', 'startTime'], null);
        const allDay = !!pick(e, ['allDay'], false);
        const time = allDay ? 'all day' : formatTime(start);
        const location = pick(e, ['location'], '');
        li.textContent = title + (time ? ', ' + time : '') + (location ? ', ' + location : '');
        ul.appendChild(li);
      }
      group.appendChild(ul);
      listEl.appendChild(group);
    }
  }

  async function refresh() {
    const profile = host.getProfile();
    if (!profile) {
      listEl.innerHTML = '<p class="empty">Pick who you are first.</p>';
      return;
    }
    const from = startOfDay(new Date());
    const to = new Date(from);
    to.setDate(to.getDate() + 7);
    try {
      const data = await host.api.getJson(
        '/api/calendar/events?profileId=' + encodeURIComponent(profile.id) + '&from=' + from.toISOString() + '&to=' + to.toISOString(),
      );
      render(data);
    } catch (err) {
      listEl.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = "Couldn't load the calendar. " + (err.message || '');
      listEl.appendChild(p);
    }
  }

  checkBtn.addEventListener('click', async () => {
    const profile = host.getProfile();
    if (!profile) return;
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking';
    try {
      await host.api.postJson('/api/google/sync', { profileId: profile.id, what: 'calendar' });
    } catch (err) {
      host.toast('Could not check the calendar. ' + (err.message || ''), { kind: 'error' });
      checkBtn.disabled = false;
      checkBtn.textContent = 'Check now';
    }
  });

  host.api.events.on('sync', (data) => {
    if (!data || (data.what !== 'calendar' && data.what !== 'both')) return;
    if (data.message) checkBtn.textContent = data.message;
    if (data.phase === 'done' || data.phase === 'error') {
      checkBtn.disabled = false;
      checkBtn.textContent = 'Check now';
      if (data.phase === 'done' && win.isOpen()) refresh();
    }
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
