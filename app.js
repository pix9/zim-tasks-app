'use strict';
/* Zim Tasks: reads and writes Zim task pages directly in private GitHub repositories. */

const $ = id => document.getElementById(id);
const API = 'https://api.github.com';
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const TASK = /^(\s*)(\*\s+)?\[([ *x<>])\]\s?(.*)$/;    // Zim checkbox line
const HEAD = /^(=+)\s*(.*?)\s*=+\s*$/;                 // Zim heading
const OPEN = /^\s*(?:\*\s+)?\[ \]/gm;
const STATE = {' ':'open', '*':'done', 'x':'cancel', '>':'moved', '<':'moved'};
const SAMPLE = `branch: main
page_path: "{yyyy}/{Month}/{yyyy}-{mm}-{dd}"
newest_first: true
repos:
  - { name: Office,   icon: "💼", github: youruser/zim-office-tasks }
  - { name: Personal, icon: "🏠", github: youruser/zim-personal-tasks }
`;

// ---------- storage ----------
const store = {
  get(k, d){ try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full: keep in memory */ } },
};
const mem = new Map();
function blobGet(sha){ if (!sha) return null; if (!mem.has(sha)) mem.set(sha, store.get('blob:' + sha, null)); return mem.get(sha); }
function blobSet(sha, text){ mem.set(sha, text); store.set('blob:' + sha, text); }

// ---------- state ----------
let cfg = null, token = '', areas = [];
let pending = store.get('pending', {});                 // unsynced edits: key -> {area, path, text, sha}
let firstRun = store.get('expanded', null) === null;
const expanded = new Set(store.get('expanded', []));
const loading = new Set(), failed = new Set();
let flushing = false, flushAgain = false, flushTimer = null, lastRefresh = 0;

// ---------- helpers ----------
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmt(t){
  return esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(?:&gt;|\[d:\s*)(\d{4}-\d{2}-\d{2})\]?/g, '<span class="due">📅 $1</span>')
    .replace(/(^|\s)(@[\w-]+)/g, '$1<span class="tag">$2</span>');
}
function build(m, state, text){ return m[1] + (m[2] || '') + '[' + state + '] ' + text; }
function el(tag, cls, html){ const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
function toast(msg){ const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3500); }
const pad2 = n => String(n).padStart(2, '0');
function todayStr(){ const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const pageTitle = p => p.split('/').pop().replace(/\.txt$/, '').replace(/_/g, ' ');
function b64enc(s){
  const bytes = new TextEncoder().encode(s); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64dec(b){ return new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\n/g, '')), c => c.charCodeAt(0))); }

// ---------- config ----------
function loadConfig(){
  const y = store.get('yaml', '');
  if (!y.trim()) return null;
  const raw = jsyaml.load(y) || {};
  const branch = String(raw.branch || 'main');
  return {
    pagePath: String(raw.page_path || '{yyyy}/{Month}/{yyyy}-{mm}-{dd}'),
    newestFirst: raw.newest_first !== false,
    repos: (raw.repos || []).filter(r => r && r.github).map(r => {
      const repo = String(r.github).trim().replace(/^(https:\/\/github\.com\/|git@github\.com:)/, '').replace(/\.git$/, '');
      return {id: repo.toLowerCase(), repo, name: String(r.name || repo), icon: String(r.icon || '📋'),
              branch: String(r.branch || branch)};
    }),
  };
}

// ---------- GitHub ----------
async function gh(path, opts = {}){
  const headers = {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'};
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(API + path, {...opts, headers, cache: 'no-store'});
  let data = null; try { data = await r.json(); } catch {}
  return {ok: r.ok, status: r.status, data};
}

async function loadArea(a){
  try {
    const r = await gh(`/repos/${a.repo}/git/trees/${encodeURIComponent(a.branch)}?recursive=1`);
    a.offline = false;
    if (r.ok){
      a.files = new Map(r.data.tree.filter(t => t.type === 'blob' && t.path.endsWith('.txt')).map(t => [t.path, t.sha]));
      a.error = null;
    } else if (r.status === 409){ a.files = new Map(); a.error = null; }           // empty repository
    else {
      a.error = r.status === 401 ? 'GitHub rejected the token (401). Check Settings.'
              : r.status === 404 ? `${a.repo} (branch "${a.branch}") not found, or the token has no access to it.`
              : `GitHub error ${r.status}`;
      return;
    }
  } catch { a.offline = true; return; }
  for (const p of Object.values(pending)) if (p.area === a.id && !a.files.has(p.path)) a.files.set(p.path, p.sha);
  store.set('tree:' + a.id, [...a.files]);
}

function cachedText(a, path){
  const p = pending[a.id + ':' + path];
  if (p) return p.text;
  return a.files ? blobGet(a.files.get(path)) : null;
}

async function fetchText(a, path){
  const sha = a.files.get(path);
  if (!sha || loading.has(sha) || failed.has(sha)) return;
  loading.add(sha);
  try {
    const r = await gh(`/repos/${a.repo}/git/blobs/${sha}`);
    if (r.ok) blobSet(sha, b64dec(r.data.content)); else { failed.add(sha); toast(`Could not load ${pageTitle(path)} (GitHub ${r.status})`); }
  } catch { failed.add(sha); }
  loading.delete(sha); render();
}

async function reloadFile(a, path){
  try {
    const r = await gh(`/repos/${a.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(a.branch)}`);
    if (r.ok){ blobSet(r.data.sha, b64dec(r.data.content)); a.files.set(path, r.data.sha); }
  } catch {}
}

// ---------- saving (queued, works offline) ----------
function setText(a, path, text){
  const key = a.id + ':' + path;
  const base = pending[key] ? pending[key].sha : (a.files.get(path) ?? null);
  pending[key] = {area: a.id, path, text, sha: base};
  store.set('pending', pending);
  updateStatus('Saving…'); render();
  clearTimeout(flushTimer); flushTimer = setTimeout(flush, 1500);
}

async function flush(){
  if (flushing){ flushAgain = true; return; }
  flushing = true;
  try {
    for (const key of Object.keys(pending)){
      const p = pending[key];
      const a = areas.find(x => x.id === p.area);
      if (!a){ delete pending[key]; continue; }
      const body = {message: `${p.sha ? 'Update' : 'Create'} ${p.path} (Zim Tasks app)`, content: b64enc(p.text), branch: a.branch};
      if (p.sha) body.sha = p.sha;
      let r;
      try { r = await gh(`/repos/${a.repo}/contents/${encPath(p.path)}`, {method: 'PUT', body: JSON.stringify(body)}); }
      catch { break; }                                             // offline: keep queued
      if (r.ok){
        const sha = r.data.content.sha;
        blobSet(sha, p.text); a.files.set(p.path, sha);
        if (pending[key] === p) delete pending[key]; else if (pending[key]) pending[key].sha = sha;
      } else if (r.status === 409 || r.status === 422){             // changed elsewhere
        await reloadFile(a, p.path);
        delete pending[key];
        toast(`"${pageTitle(p.path)}" was changed on another device. Loaded the latest version; please redo your change.`);
      } else {
        toast(`Could not save "${pageTitle(p.path)}" (GitHub ${r.status}).${r.status === 401 ? ' Check your token in Settings.' : ''}`);
        break;
      }
      store.set('pending', pending);
      store.set('tree:' + a.id, [...a.files]);
    }
  } finally {
    store.set('pending', pending);
    flushing = false; updateStatus(); render();
    if (flushAgain){ flushAgain = false; flush(); }
  }
}

function mutate(a, path, fn){
  const text = cachedText(a, path); if (text === null) return;
  const lines = text.split('\n'); fn(lines); setText(a, path, lines.join('\n'));
}

// ---------- tree ----------
function buildTree(a){
  const root = {name: '', path: '', children: new Map(), file: null};
  for (const p of (a.files ? a.files.keys() : [])){
    const parts = p.slice(0, -4).split('/'); let node = root;
    parts.forEach((seg, i) => {
      if (!node.children.has(seg)) node.children.set(seg, {name: seg, path: parts.slice(0, i + 1).join('/'), children: new Map(), file: null});
      node = node.children.get(seg);
    });
    node.file = p;
  }
  return root;
}
function sortKey(name){
  const m = MONTHS.indexOf(name);
  if (m >= 0) return {date: true, v: pad2(m + 1)};
  const nm = name.match(/^(\d{1,2})[-_ ]([A-Za-z]+)$/);
  if (nm && MONTHS.includes(nm[2])) return {date: true, v: pad2(+nm[1])};
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(name)) return {date: true, v: name};
  return {date: false, v: name};
}
function sortedChildren(node){
  return [...node.children.values()].sort((x, y) => {
    const a = sortKey(x.name), b = sortKey(y.name);
    if (a.date !== b.date) return a.date ? -1 : 1;
    const c = a.v.localeCompare(b.v, undefined, {numeric: true});
    return a.date && cfg.newestFirst ? -c : c;
  });
}
function countOpen(a, node){
  let n = 0;
  if (node.file){ const t = cachedText(a, node.file); if (t) n += (t.match(OPEN) || []).length; }
  for (const c of node.children.values()) n += countOpen(a, c);
  return n;
}
function toggleExpand(key){ expanded.has(key) ? expanded.delete(key) : expanded.add(key); store.set('expanded', [...expanded]); render(); }
function expandTo(a, file){
  expanded.add('A:' + a.id);
  const parts = file.slice(0, -4).split('/');
  for (let i = 1; i <= parts.length; i++) expanded.add(a.id + ':' + parts.slice(0, i).join('/'));
  store.set('expanded', [...expanded]);
}
function expandNewest(a){
  if (!a.files || !a.files.size) return;
  let node = buildTree(a);
  while (node.children.size) node = sortedChildren(node)[0];
  if (node.file) expandTo(a, node.file);
}

// ---------- rendering ----------
const badge = n => n ? `<span class="badge">${n}</span>` : '';

function render(){
  const root = $('tree'); root.innerHTML = '';
  if (!cfg || !token){ root.appendChild(el('div', 'msg', 'Open ⚙︎ Settings to add your GitHub token and configuration.')); return; }
  for (const a of areas){
    const key = 'A:' + a.id, open = expanded.has(key), tree = buildTree(a);
    const box = el('div', 'area' + (open ? ' open' : ''));
    const head = el('div', 'row', `<span class="chev">▸</span><span class="name">${esc(a.icon)} ${esc(a.name)}</span>${badge(countOpen(a, tree))}`);
    head.onclick = () => toggleExpand(key);
    box.appendChild(head);
    if (open){
      if (a.error) box.appendChild(el('div', 'msg', esc(a.error)));
      else if (!a.files) box.appendChild(el('div', 'msg', a.offline ? 'Offline, and this area has not been downloaded yet.' : 'Loading…'));
      else if (!a.files.size) box.appendChild(el('div', 'msg', 'No task lists yet. Tap ＋ New.'));
      else for (const c of sortedChildren(tree)) renderNode(box, a, c, 1);
    }
    root.appendChild(box);
  }
}

function renderNode(parent, a, node, depth){
  const key = a.id + ':' + node.path, open = expanded.has(key);
  const wrap = el('div', 'node' + (open ? ' open' : '') + (node.name === todayStr() ? ' today' : ''));
  const row = el('div', 'row', `<span class="chev">▸</span><span class="name">${esc(node.name.replace(/_/g, ' '))}</span>${badge(countOpen(a, node))}`);
  row.style.paddingLeft = (10 + depth * 16) + 'px';
  row.onclick = () => toggleExpand(key);
  wrap.appendChild(row);
  if (open){
    if (node.file) renderPage(wrap, a, node.file, depth + 1);
    for (const c of sortedChildren(node)) renderNode(wrap, a, c, depth + 1);
  }
  parent.appendChild(wrap);
}

function renderPage(parent, a, path, depth){
  const pad = 10 + depth * 16;
  const text = cachedText(a, path);
  if (text === null){
    const sha = a.files.get(path);
    const m = el('div', 'msg', failed.has(sha) ? 'Not downloaded yet (offline). Tap ↻ Refresh when online.' : 'Loading…');
    m.style.paddingLeft = pad + 'px'; parent.appendChild(m);
    fetchText(a, path); return;
  }
  const hide = $('hideDone').checked;
  text.split('\n').forEach((ln, i) => {
    const h = ln.match(HEAD);
    if (h){
      if (h[1].length < 6){ const s = el('div', 'sub'); s.textContent = h[2]; s.style.paddingLeft = pad + 'px'; parent.appendChild(s); }
      return;
    }
    const m = ln.match(TASK); if (!m) return;
    const st = m[3], done = st === '*' || st === 'x';
    if (hide && done) return;
    const row = el('div', 'task s' + STATE[st], `<input type="checkbox" ${done ? 'checked' : ''}><span class="txt">${fmt(m[4])}</span>`);
    row.style.paddingLeft = (pad + m[1].replace(/ {4}/g, '\t').length * 22) + 'px';
    row.querySelector('input').onchange = () => mutate(a, path, ls => {
      const mm = ls[i].match(TASK); if (mm) ls[i] = build(mm, mm[3] === ' ' ? '*' : ' ', mm[4]);
    });
    row.querySelector('.txt').onclick = () => {
      const t = prompt('Edit task (leave empty to delete):', m[4]);
      if (t === null) return;
      mutate(a, path, ls => { const mm = ls[i].match(TASK); if (!mm) return; if (t.trim() === '') ls.splice(i, 1); else ls[i] = build(mm, mm[3], t); });
    };
    parent.appendChild(row);
  });
  const addKey = a.id + ':' + path;
  const add = el('form', 'add', '<input placeholder="Add a task…" autocomplete="off"><button>Add</button>');
  add.dataset.key = addKey; add.style.paddingLeft = pad + 'px';
  add.onsubmit = e => {
    e.preventDefault();
    const v = add.querySelector('input').value.trim(); if (!v) return;
    mutate(a, path, ls => { let j = ls.length; while (j > 0 && !ls[j - 1].trim()) j--; ls.splice(j, 0, '[ ] ' + v); });
    const again = [...document.querySelectorAll('form.add')].find(f => f.dataset.key === addKey);
    if (again) again.querySelector('input').focus();          // keep the keyboard open for the next task
  };
  parent.appendChild(add);
}

function updateStatus(msg){
  const n = Object.keys(pending).length, off = !navigator.onLine || areas.some(x => x.offline);
  $('status').textContent = msg || (n ? `${n} page${n > 1 ? 's' : ''} waiting to sync${off ? ' (offline)' : ''}`
                                      : off ? 'Offline: showing your saved copy' : 'Up to date with GitHub');
}

// ---------- refresh ----------
async function refresh(){
  if (!cfg || !token) return render();
  lastRefresh = Date.now(); failed.clear();
  updateStatus('Syncing…');
  await flush();
  await Promise.all(areas.map(loadArea));
  if (areas.every(a => !a.error && !a.offline)){                    // tidy up cached old versions
    const keep = new Set(); areas.forEach(a => a.files && a.files.forEach(s => s && keep.add(s)));
    for (let i = localStorage.length - 1; i >= 0; i--){
      const k = localStorage.key(i);
      if (k && k.startsWith('blob:') && !keep.has(k.slice(5))){ localStorage.removeItem(k); mem.delete(k.slice(5)); }
    }
  }
  if (firstRun){ areas.forEach(expandNewest); firstRun = false; }
  const t = todayStr();
  if (store.get('autoDay', '') !== t){                                // open today's lists once a day
    areas.forEach(a => a.files && a.files.forEach((_, f) => { if (f.split('/').pop() === t + '.txt') expandTo(a, f); }));
    store.set('autoDay', t);
  }
  updateStatus(); render();
}

// ---------- new list ----------
function pagePathFor(date){
  const [y, m, d] = date.split('-'), Month = MONTHS[+m - 1];
  return cfg.pagePath.replace(/\{yyyy\}/g, y).replace(/\{mm\}/g, m).replace(/\{dd\}/g, d)
    .replace(/\{Month\}/g, Month).replace(/\{Mon\}/g, Month.slice(0, 3))
    .replace(/:/g, '/').replace(/ /g, '_').replace(/^\/+|\/+$/g, '') + '.txt';
}
function zimPage(title, tasks){
  const d = new Date(), off = -d.getTimezoneOffset();
  const tz = (off >= 0 ? '+' : '-') + pad2(Math.floor(Math.abs(off) / 60)) + ':' + pad2(Math.abs(off) % 60);
  const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${tz}`;
  return ['Content-Type: text/x-zim-wiki', 'Wiki-Format: zim 0.6', 'Creation-Date: ' + stamp, '',
          `====== ${title} ======`, `Created ${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`, '',
          ...tasks.map(t => '[ ] ' + t), ''].join('\n');
}
$('newBtn').onclick = () => {
  if (!cfg || !areas.length) return openSettings();
  const sel = $('newRepo'); sel.innerHTML = '';
  areas.forEach((a, i) => sel.add(new Option(a.icon + ' ' + a.name, i)));
  const last = store.get('lastArea', 0); sel.value = last < areas.length ? last : 0;
  $('newDate').value = todayStr(); $('newTasks').value = '';
  $('newDlg').showModal();
};
$('newCancel').onclick = () => $('newDlg').close();
$('newForm').onsubmit = e => {
  e.preventDefault();
  const idx = +$('newRepo').value, a = areas[idx], date = $('newDate').value;
  if (!a || !date) return;
  store.set('lastArea', idx); $('newDlg').close();
  const path = pagePathFor(date);
  if (!a.files) a.files = new Map();
  if (a.files.has(path)){ expandTo(a, path); render(); toast('That list already exists; opened it.'); return; }
  const tasks = $('newTasks').value.split('\n').map(s => s.trim()).filter(Boolean);
  a.files.set(path, null); expandTo(a, path);
  setText(a, path, zimPage(pageTitle(path), tasks));
};

// ---------- settings ----------
function openSettings(){ $('tokenIn').value = token; $('yamlIn').value = store.get('yaml', '') || SAMPLE; $('settingsDlg').showModal(); }
$('settingsBtn').onclick = openSettings;
$('settingsCancel').onclick = () => $('settingsDlg').close();
$('settingsForm').onsubmit = e => {
  e.preventDefault();
  const y = $('yamlIn').value;
  try { jsyaml.load(y); } catch (err) { alert('YAML error:\n' + err.message); return; }
  store.set('token', $('tokenIn').value.trim()); store.set('yaml', y);
  $('settingsDlg').close(); init();
};

// ---------- wiring ----------
$('refreshBtn').onclick = refresh;
$('collapseBtn').onclick = () => { expanded.clear(); store.set('expanded', []); render(); };
$('hideDone').checked = store.get('hideDone', false);
$('hideDone').onchange = () => { store.set('hideDone', $('hideDone').checked); render(); };
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
  else if (Date.now() - lastRefresh > 30000) refresh();
});
window.addEventListener('online', refresh);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

function init(){
  token = store.get('token', '');
  try { cfg = loadConfig(); } catch (err) { cfg = null; toast('Config error: ' + err.message); }
  areas = cfg ? cfg.repos.map(r => {
    const cached = store.get('tree:' + r.id, null);
    const a = {...r, files: cached ? new Map(cached) : null, error: null, offline: false};
    for (const p of Object.values(pending)) if (p.area === a.id){ a.files = a.files || new Map(); if (!a.files.has(p.path)) a.files.set(p.path, p.sha); }
    return a;
  }) : [];
  render(); updateStatus();
  if (!cfg || !token) openSettings(); else refresh();
}
init();
