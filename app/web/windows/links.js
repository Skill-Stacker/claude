// windows/links.js: "Leaving This Machine". Scout only ever reaches three
// real destinations outside this stick (see CLAUDE.md): the two Google
// account pages the Connect wizard sends you to, and calendar.google.com
// for the prefilled "add to calendar" link and the secret address
// instructions. Gmail itself is read and sent over IMAP/SMTP directly, no
// browser tab involved, so those two entries below are informational only
// (no href) rather than a link to the Gmail website Scout never opens.

const TILES = [
  {
    name: 'Google Account Security',
    icon: 'A',
    href: 'https://myaccount.google.com/security',
    note: 'Turn on 2-Step Verification here before making an app password.',
  },
  {
    name: 'App Passwords',
    icon: 'K',
    href: 'https://myaccount.google.com/apppasswords',
    note: 'Create the app password Scout uses to read and send your mail.',
  },
  {
    name: 'Google Calendar',
    icon: 'D',
    href: 'https://calendar.google.com/',
    note: 'Where the prefilled add-to-calendar link opens, and where your calendar\'s secret address lives.',
  },
  {
    name: 'Gmail, over IMAP and SMTP',
    icon: 'M',
    href: null,
    note: 'Scout signs in with your app password and reads and sends mail directly. It never opens the Gmail website.',
  },
  {
    name: 'Your calendar feed',
    icon: 'F',
    href: null,
    note: "Scout reads your events from your calendar's private address on its own. Adding an event opens the Google Calendar link above instead.",
  },
];

export function mount(host) {
  const win = host.createWindow({ id: 'links', title: 'Leaving This Machine', icon: 'L', width: 520, height: 460, left: 240, top: 100 });
  const body = win.body;
  body.classList.add('links-body');

  const intro = document.createElement('p');
  intro.className = 'links-intro';
  intro.textContent =
    'Everything else Scout does stays on this stick. These are the only places any of it reaches out to the internet, and only when you use them.';
  body.appendChild(intro);

  const grid = document.createElement('div');
  grid.className = 'links-grid';
  for (const tile of TILES) {
    const el = document.createElement(tile.href ? 'a' : 'div');
    el.className = 'link-tile';
    if (tile.href) {
      el.href = tile.href;
      el.target = '_blank';
      el.rel = 'noopener';
    }
    const iconEl = document.createElement('span');
    iconEl.className = 'link-tile-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = tile.icon;
    const nameEl = document.createElement('span');
    nameEl.className = 'link-tile-name';
    nameEl.textContent = tile.name;
    const noteEl = document.createElement('span');
    noteEl.className = 'link-tile-note';
    noteEl.textContent = tile.note;
    const badge = document.createElement('span');
    badge.className = 'leaves-badge';
    badge.textContent = 'leaves this machine';
    el.append(iconEl, nameEl, noteEl, badge);
    grid.appendChild(el);
  }
  body.appendChild(grid);

  return win;
}
