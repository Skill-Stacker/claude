// windows/netlog.js: "What Scout just did". GET /api/netlog returns
// { entries, description } (see app/lib/netlog.js for the exact entry
// shape: id, time, kind, host, purpose, bytes, ok, detail); SSE 'netlog'
// pushes one new entry at a time as it happens.

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  if (n < 1000) return n + ' B';
  if (n < 1000000) return Math.round(n / 100) / 10 + ' KB';
  return Math.round(n / 100000) / 10 + ' MB';
}

export function mount(host) {
  const win = host.createWindow({ id: 'netlog', title: 'What Scout Just Did', icon: 'N', width: 460, height: 480, left: 200, top: 120 });
  const body = win.body;
  body.classList.add('netlog-body');

  const descEl = document.createElement('p');
  descEl.className = 'netlog-desc';
  const listEl = document.createElement('ul');
  listEl.className = 'netlog-list';
  body.append(descEl, listEl);

  function rowFor(entry) {
    const li = document.createElement('li');
    li.className = 'netlog-row' + (entry.ok === false ? ' failed' : '');
    const time = document.createElement('span');
    time.className = 'netlog-time';
    time.textContent = formatTime(entry.time);
    const purpose = document.createElement('span');
    purpose.className = 'netlog-purpose';
    purpose.textContent = entry.purpose || entry.kind || 'network call';
    const host2 = document.createElement('span');
    host2.className = 'netlog-host';
    host2.textContent = entry.host || '';
    const extra = document.createElement('span');
    extra.className = 'netlog-extra';
    const bytesText = formatBytes(entry.bytes);
    extra.textContent = (entry.ok === false ? 'failed' : 'ok') + (bytesText ? ', ' + bytesText : '');
    li.append(time, purpose, host2, extra);
    return li;
  }

  function prepend(entry) {
    const empty = listEl.querySelector('.empty');
    if (empty) empty.remove();
    listEl.insertBefore(rowFor(entry), listEl.firstChild);
  }

  async function refresh() {
    try {
      const data = await host.api.getJson('/api/netlog');
      descEl.textContent = data.description || '';
      listEl.innerHTML = '';
      const entries = Array.isArray(data.entries) ? data.entries.slice().reverse() : [];
      if (!entries.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'Scout has not reached the internet yet.';
        listEl.appendChild(li);
        return;
      }
      for (const entry of entries) listEl.appendChild(rowFor(entry));
    } catch (err) {
      listEl.innerHTML = '';
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = "Couldn't load this list. " + (err.message || '');
      listEl.appendChild(li);
    }
  }

  host.api.events.on('netlog', (entry) => {
    if (entry) prepend(entry);
  });

  const originalOpen = win.open;
  win.open = function open() {
    originalOpen();
    refresh();
  };

  return win;
}
