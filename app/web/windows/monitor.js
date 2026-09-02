// windows/monitor.js: a placeholder that renders /api/monitor once that
// studio module exists. Until then GET /api/monitor answers 404 and this
// window just says so plainly.

function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-';
  const gb = n / (1000 * 1000 * 1000);
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  const mb = n / (1000 * 1000);
  return Math.round(mb) + ' MB';
}

export function mount(host) {
  const win = host.createWindow({ id: 'monitor', title: 'Monitor', icon: 'V', width: 380, height: 340, left: 260, top: 110 });
  const body = win.body;
  body.classList.add('monitor-body');

  const placeholder = document.createElement('p');
  placeholder.className = 'empty';
  placeholder.textContent = 'Studio tools are not part of this build yet.';

  const grid = document.createElement('div');
  grid.className = 'monitor-grid';
  grid.hidden = true;
  const cpuRow = document.createElement('div');
  const ramRow = document.createElement('div');
  const diskRow = document.createElement('div');
  const gpuRow = document.createElement('div');
  grid.append(cpuRow, ramRow, diskRow, gpuRow);

  body.append(placeholder, grid);

  let available = false;
  let watching = false;

  function render(data) {
    if (!data) return;
    cpuRow.textContent = 'Processor: ' + (typeof data.cpu === 'number' ? Math.round(data.cpu) + '%' : '-');
    ramRow.textContent = 'Memory: ' + (data.ram ? formatBytes(data.ram.used) + ' of ' + formatBytes(data.ram.total) : '-');
    diskRow.textContent = 'Free space: ' + (data.disk ? formatBytes(data.disk.free) : '-');
    gpuRow.textContent = data.gpu
      ? 'Graphics card: ' + data.gpu.name + (typeof data.gpu.util === 'number' ? ', ' + Math.round(data.gpu.util) + '%' : '')
      : 'Graphics card: not in use';
  }

  async function setWatch(on) {
    if (!available || watching === on) return;
    watching = on;
    try {
      await host.api.postJson('/api/monitor/watch', { on });
    } catch {
      // best effort: the live updates just would not arrive
    }
  }

  host.api.events.on('monitor', (data) => {
    if (available && win.isOpen()) render(data);
  });

  const originalOpen = win.open;
  win.open = async function open() {
    originalOpen();
    if (!available) {
      try {
        const data = await host.api.getJson('/api/monitor');
        available = true;
        placeholder.hidden = true;
        grid.hidden = false;
        render(data);
      } catch (err) {
        available = false;
        placeholder.hidden = false;
        grid.hidden = true;
        if (err && err.status && err.status !== 404) {
          placeholder.textContent = "Couldn't check on this. " + (err.message || '');
        }
        return;
      }
    }
    setWatch(true);
  };

  const originalClose = win.close;
  win.close = function close() {
    originalClose();
    setWatch(false);
  };
  const originalMinimize = win.minimize;
  win.minimize = function minimize() {
    originalMinimize();
    setWatch(false);
  };

  return win;
}
