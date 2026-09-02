// windows/mail.js: a read-only view of the cached inbox. GET
// /api/mail/threads and GET /api/mail/thread; "Check now" triggers POST
// /api/google/sync and follows the SSE 'sync' events back to a refresh.

function pick(obj, keys, fallback) {
  for (const key of keys) {
    if (obj && obj[key] != null && obj[key] !== '') return obj[key];
  }
  return fallback;
}

function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function mount(host) {
  const win = host.createWindow({ id: 'mail', title: 'Mail', icon: 'M', width: 460, height: 520, left: 160, top: 100 });
  const body = win.body;
  body.classList.add('mail-body');

  const header = document.createElement('div');
  header.className = 'list-header';
  const asOfEl = document.createElement('span');
  asOfEl.className = 'as-of';
  const checkBtn = document.createElement('button');
  checkBtn.type = 'button';
  checkBtn.className = 'btn-ghost';
  checkBtn.textContent = 'Check now';
  header.append(asOfEl, checkBtn);

  const listEl = document.createElement('ul');
  listEl.className = 'thread-list lockable';

  const detailEl = document.createElement('div');
  detailEl.className = 'thread-detail lockable';
  detailEl.hidden = true;
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn-ghost';
  backBtn.textContent = 'Back to inbox';
  const detailSubject = document.createElement('h4');
  const detailMessages = document.createElement('div');
  detailMessages.className = 'message-list';
  detailEl.append(backBtn, detailSubject, detailMessages);

  body.append(header, listEl, detailEl);

  function showList() {
    listEl.hidden = false;
    detailEl.hidden = true;
  }
  function showDetail() {
    listEl.hidden = true;
    detailEl.hidden = false;
  }
  backBtn.addEventListener('click', showList);

  async function openThread(thread) {
    const profile = host.getProfile();
    if (!profile) return;
    detailSubject.textContent = pick(thread, ['subject'], '(no subject)');
    detailMessages.innerHTML = '<p class="empty">Loading</p>';
    showDetail();
    try {
      const data = await host.api.getJson(
        '/api/mail/thread?profileId=' + encodeURIComponent(profile.id) + '&id=' + encodeURIComponent(thread.id),
      );
      const messages = Array.isArray(data && data.messages) ? data.messages : [];
      detailMessages.innerHTML = '';
      if (!messages.length) {
        const p = document.createElement('p');
        p.className = 'empty';
        p.textContent = 'No messages found in this thread.';
        detailMessages.appendChild(p);
      }
      for (const m of messages) {
        const row = document.createElement('div');
        row.className = 'message-row';
        const meta = document.createElement('div');
        meta.className = 'message-meta';
        meta.textContent = pick(m, ['from'], 'Unknown sender') + ', ' + formatWhen(pick(m, ['date', 'receivedUtc'], null));
        const text = document.createElement('div');
        text.className = 'message-text';
        text.textContent = pick(m, ['body', 'text', 'snippet'], '');
        row.append(meta, text);
        detailMessages.appendChild(row);
      }
    } catch (err) {
      detailMessages.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = "Couldn't load this thread. " + (err.message || '');
      detailMessages.appendChild(p);
    }
  }

  function render(data) {
    asOfEl.textContent = data.asOf ? 'As of ' + formatWhen(data.asOf) : '';
    listEl.innerHTML = '';
    const threads = Array.isArray(data.threads) ? data.threads : [];
    if (!threads.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No mail yet. Connect Gmail from the Connect window.';
      listEl.appendChild(li);
      return;
    }
    for (const t of threads) {
      const li = document.createElement('li');
      li.className = 'thread-row' + (t.unread ? ' unread' : '');
      const subject = document.createElement('span');
      subject.className = 'thread-subject';
      subject.textContent = pick(t, ['subject'], '(no subject)');
      const from = document.createElement('span');
      from.className = 'thread-from';
      from.textContent = pick(t, ['from'], '');
      const when = document.createElement('span');
      when.className = 'thread-when';
      when.textContent = formatWhen(pick(t, ['date', 'receivedUtc'], null));
      li.append(subject, from, when);
      li.addEventListener('click', () => openThread(t));
      listEl.appendChild(li);
    }
  }

  async function refresh() {
    const profile = host.getProfile();
    if (!profile) {
      listEl.innerHTML = '<li class="empty">Pick who you are first.</li>';
      return;
    }
    showList();
    try {
      const data = await host.api.getJson('/api/mail/threads?profileId=' + encodeURIComponent(profile.id) + '&limit=30');
      render(data);
    } catch (err) {
      listEl.innerHTML = '';
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = "Couldn't load mail. " + (err.message || '');
      listEl.appendChild(li);
    }
  }

  checkBtn.addEventListener('click', async () => {
    const profile = host.getProfile();
    if (!profile) return;
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking';
    try {
      await host.api.postJson('/api/google/sync', { profileId: profile.id, what: 'gmail' });
    } catch (err) {
      host.toast('Could not check mail. ' + (err.message || ''), { kind: 'error' });
      checkBtn.disabled = false;
      checkBtn.textContent = 'Check now';
    }
  });

  host.api.events.on('sync', (data) => {
    if (!data || (data.what !== 'gmail' && data.what !== 'both')) return;
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
