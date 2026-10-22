const cfg = window.MAPASS_CONFIG || {};
const $ = s => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const LOCAL_KEY = 'mapass-history-v1'; // histórico da versão antiga, só no navegador
const configured = cfg.url && !cfg.url.includes('SEU-PROJETO') && cfg.anonKey && !cfg.anonKey.includes('COLE');
const sb = configured ? supabase.createClient(cfg.url, cfg.anonKey) : null;

let me = null, bootedFor = null;
let tried = [];     // meus padrões, na ordem de exibição
let contacts = [];
let requests = [];  // pedidos enviados e recebidos, com as sugestões
let seen = null;    // último estado visto, para os avisos
let helpReqId = null, helpTried = [];
let channel = null, pollTimer = null;

// ---------- padrões ----------
const pos = i => ({ x: 50 + (i % 3) * 100, y: 50 + Math.floor(i / 3) * 100 });
const keyOf = p => p.map(i => i + 1).join('-');
const parseKey = k => k.split('-').map(n => +n - 1);
const fmtSeq = p => p.map(i => i + 1).join(' → ');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function el(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function renderPattern(svg, p, opts = {}) {
  svg.innerHTML = '';
  const color = opts.color || 'var(--accent)';
  const r = opts.dotR || 14;
  if (p.length) {
    const pts = p.map(pos).map(q => `${q.x},${q.y}`);
    if (opts.cursor) pts.push(`${opts.cursor.x},${opts.cursor.y}`);
    el('polyline', { points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': opts.stroke || 8,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: .8 }, svg);
  }
  for (let i = 0; i < 9; i++) {
    const q = pos(i);
    const idx = p.indexOf(i);
    const on = idx >= 0;
    el('circle', { cx: q.x, cy: q.y, r: on ? r : r * 0.7, fill: on ? (idx === 0 ? 'var(--ok)' : color) : 'var(--dot)' }, svg);
    if (opts.numbers && on) {
      const t = el('text', { x: q.x, y: q.y + r * 0.36, 'text-anchor': 'middle', 'font-size': r,
        'font-weight': 700, fill: '#fff' }, svg);
      t.textContent = idx + 1;
    }
  }
}

function miniSvg(p, color, big) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 300 300');
  renderPattern(svg, p, big ? { color, numbers: true, dotR: 26, stroke: 12 } : { color, stroke: 14, dotR: 20 });
  return svg;
}

// grade de desenho, igual à do Android
function createPad(svg, { seqEl, onStart, onFinish }) {
  let path = [], drawing = false, cursor = null;
  const hit = pt => {
    for (let i = 0; i < 9; i++) {
      const q = pos(i);
      if (Math.hypot(q.x - pt.x, q.y - pt.y) < 34) return i;
    }
    return -1;
  };
  const add = i => {
    if (i < 0 || path.includes(i)) return;
    if (path.length) {
      const a = path[path.length - 1];
      const ra = Math.floor(a / 3), ca = a % 3, rb = Math.floor(i / 3), cb = i % 3;
      if ((ra + rb) % 2 === 0 && (ca + cb) % 2 === 0) {
        const mid = ((ra + rb) / 2) * 3 + (ca + cb) / 2;
        if (!path.includes(mid)) path.push(mid);
      }
    }
    path.push(i);
    if (navigator.vibrate) navigator.vibrate(10);
  };
  const point = ev => {
    const r = svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * 300 / r.width, y: (ev.clientY - r.top) * 300 / r.height };
  };
  const redraw = () => {
    renderPattern(svg, path, { cursor: drawing ? cursor : null, numbers: true });
    seqEl.textContent = path.length ? fmtSeq(path) : '';
  };
  svg.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    svg.setPointerCapture(ev.pointerId);
    path = []; drawing = true;
    cursor = point(ev);
    add(hit(cursor));
    redraw();
    onStart();
  });
  svg.addEventListener('pointermove', ev => {
    if (!drawing) return;
    cursor = point(ev);
    add(hit(cursor));
    redraw();
  });
  const end = () => {
    if (!drawing) return;
    drawing = false;
    redraw();
    onFinish(path.slice());
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  redraw();
  return { clear() { path = []; redraw(); } };
}

// ---------- utilidades ----------
function setStatus(elm, text, cls) {
  elm.textContent = text;
  elm.className = elm.className.split(' ')[0] + (cls ? ' ' + cls : '');
}

function ago(ts) {
  const s = (Date.now() - new Date(ts)) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return new Date(ts).toLocaleString('pt-BR');
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

function notify(title, body) {
  toast(`${title} ${body}`);
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body }); } catch {}
  }
}

const debounced = (fn, ms = 300) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
const nameOf = id => id === me?.id ? 'você' : (contacts.find(c => c.id === id)?.name || 'alguém');

function showTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('[data-panel]').forEach(s => { s.hidden = s.dataset.panel !== name; });
  try { localStorage.setItem('mapass-tab', name); } catch {}
}
document.querySelectorAll('.tab').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });

// ---------- login ----------
let authMode = 'login';
function setAuthMode(m) {
  authMode = m;
  $('#nameRow').hidden = m === 'login';
  $('#authSubmit').textContent = m === 'login' ? 'Entrar' : 'Criar conta';
  $('#authToggle').textContent = m === 'login' ? 'Não tem conta? Criar uma' : 'Já tenho conta';
  $('#password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  setStatus($('#authMsg'), '');
}
$('#authToggle').onclick = () => setAuthMode(authMode === 'login' ? 'signup' : 'login');

const AUTH_ERRORS = {
  'Invalid login credentials': 'E-mail ou senha errados.',
  'User already registered': 'Já existe uma conta com esse e-mail.',
  'Email not confirmed': 'Confirme seu e-mail antes de entrar (veja sua caixa de entrada).',
  'Password should be at least 6 characters.': 'A senha precisa ter pelo menos 6 caracteres.',
};

$('#authForm').onsubmit = async ev => {
  ev.preventDefault();
  const email = $('#email').value.trim(), password = $('#password').value;
  setStatus($('#authMsg'), 'Aguarde…');
  const res = authMode === 'login'
    ? await sb.auth.signInWithPassword({ email, password })
    : await sb.auth.signUp({ email, password, options: { data: { name: $('#name').value.trim() } } });
  if (res.error) return setStatus($('#authMsg'), AUTH_ERRORS[res.error.message] || res.error.message, 'bad');
  if (authMode === 'signup' && !res.data.session) {
    setStatus($('#authMsg'), 'Conta criada! Confirme pelo link que chegou no seu e-mail e depois entre.', 'ok');
    setAuthMode('login');
  } else {
    setStatus($('#authMsg'), '');
  }
};

$('#btnLogout').onclick = () => sb.auth.signOut();

async function boot(user) {
  if (bootedFor === user.id) return;
  bootedFor = user.id;
  const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (error) { bootedFor = null; return toast('Erro ao carregar seu perfil: ' + error.message); }
  me = data;
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#meName').textContent = me.name || me.email;
  let tab = 'tentar';
  try { tab = localStorage.getItem('mapass-tab') || tab; } catch {}
  showTab(tab);
  await loadContacts();
  await Promise.all([loadTried(), loadRequests()]);
  subscribe();
  offerLocalImport();
  updateBell();
}

function logoutUI() {
  bootedFor = null; me = null; seen = null; helpReqId = null;
  tried = []; contacts = []; requests = [];
  if (channel) { sb.removeChannel(channel); channel = null; }
  clearInterval(pollTimer);
  $('#app').hidden = true;
  $('#auth').hidden = false;
  document.title = 'MaPass';
}

function updateBell() {
  $('#btnBell').hidden = !('Notification' in window) || Notification.permission !== 'default';
}
$('#btnBell').onclick = async () => { await Notification.requestPermission(); updateBell(); };

// ---------- tempo real ----------
const refreshRequests = debounced(() => me && loadRequests());
const refreshTried = debounced(async () => {
  if (!me) return;
  if (!drag) await loadTried();
  if (currentHelp()) { await loadHelpTried(); renderHelpPanel(); }
});

function subscribe() {
  channel = sb.channel('mapass-' + me.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'help_requests' }, refreshRequests)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'suggestions' }, refreshRequests)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tried' }, refreshTried)
    .subscribe();
  // garantia caso o tempo real caia
  pollTimer = setInterval(refreshRequests, 15000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRequests(); });

// ---------- aba Tentar ----------
const histEl = $('#hist');
const statusEl = $('#status');
const btnFail = $('#btnFail');
const btnWin = $('#btnWin');
let myPath = null;

const myPad = createPad($('#pad'), {
  seqEl: $('#seq'),
  onStart: () => {
    myPath = null;
    btnFail.disabled = btnWin.disabled = true;
    setStatus(statusEl, 'Desenhando…');
    highlight(-1);
  },
  onFinish: evaluateMine,
});

function evaluateMine(p) {
  if (!p.length) return setStatus(statusEl, 'Desenhe um padrão');
  if (p.length < 4) return setStatus(statusEl, 'Mínimo de 4 pontos (o Android não aceita menos)', 'warn');
  const idx = tried.findIndex(t => t.pattern === keyOf(p));
  if (idx >= 0) {
    const h = tried[idx];
    const via = h.source ? `, sugerido por ${h.source}` : '';
    setStatus(statusEl, `JÁ TENTOU esse! (tentativa nº ${h.n}, ${new Date(h.created_at).toLocaleString('pt-BR')}${via})`, 'bad');
    highlight(idx);
    return;
  }
  myPath = p;
  setStatus(statusEl, 'Padrão novo. Vai lá testar no celular!', 'ok');
  btnFail.disabled = btnWin.disabled = false;
}

const nextN = () => tried.reduce((m, t) => Math.max(m, t.n), 0) + 1;

async function record(ok) {
  if (!myPath) return;
  const p = myPath;
  myPath = null;
  btnFail.disabled = btnWin.disabled = true;
  const n = nextN();
  const top = tried.length ? Math.min(...tried.map(t => t.pos)) - 1 : 0;
  const { data, error } = await sb.from('tried').insert({ pattern: keyOf(p), ok, n, pos: top }).select().single();
  if (error) return setStatus(statusEl, 'Não consegui salvar: ' + error.message, 'bad');
  tried.unshift(data);
  renderHistory();
  if (ok) {
    setStatus(statusEl, `🎉 Esse é o seu padrão: ${fmtSeq(p)}. Anote em algum lugar!`, 'ok');
  } else {
    setStatus(statusEl, `Registrado como tentativa nº ${n}. Desenhe o próximo.`);
    myPad.clear();
  }
}

btnFail.onclick = () => record(false);
btnWin.onclick = () => record(true);
$('#btnClear').onclick = () => {
  myPath = null;
  btnFail.disabled = btnWin.disabled = true;
  setStatus(statusEl, 'Desenhe um padrão');
  highlight(-1);
  myPad.clear();
};

async function loadTried() {
  const { data, error } = await sb.from('tried').select('*').eq('user_id', me.id)
    .order('pos').order('created_at', { ascending: false });
  if (error) return toast(error.message);
  tried = data;
  renderHistory();
}

function triedItem(h) {
  const div = document.createElement('div');
  div.className = 'item' + (h.ok ? ' win' : '');
  div.innerHTML = `<div class="n">#${h.n}${h.ok ? ' ✓' : ''}</div>`;
  div.appendChild(miniSvg(parseKey(h.pattern), h.ok ? 'var(--ok)' : 'var(--bad)'));
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = h.pattern + (h.source ? ` · via ${h.source}` : '');
  div.appendChild(meta);
  return div;
}

function renderHistory() {
  $('#count').textContent = tried.length;
  histEl.innerHTML = '';
  if (!tried.length) {
    histEl.innerHTML = '<div class="empty">Nenhuma tentativa ainda.</div>';
    return;
  }
  tried.forEach((h, i) => {
    const div = triedItem(h);
    div.dataset.idx = i;
    const del = document.createElement('button');
    del.className = 'del'; del.title = 'Remover'; del.textContent = '×';
    del.onclick = async () => {
      if (!confirm(`Remover a tentativa #${h.n} (${h.pattern})?`)) return;
      const { error } = await sb.from('tried').delete().eq('id', h.id);
      if (error) return toast(error.message);
      tried = tried.filter(t => t !== h);
      renderHistory();
    };
    div.appendChild(del);
    histEl.appendChild(div);
  });
}

function highlight(idx) {
  histEl.querySelectorAll('.item.hit').forEach(e => e.classList.remove('hit'));
  if (idx < 0) return;
  const e = histEl.querySelector(`.item[data-idx="${idx}"]`);
  if (e) { e.classList.add('hit'); e.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

// ---------- arrastar para organizar ----------
let drag = null;

histEl.addEventListener('pointerdown', ev => {
  const item = ev.target.closest('.item');
  if (!item || ev.target.closest('.del') || ev.button > 0) return;
  drag = { item, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, active: false, touch: ev.pointerType !== 'mouse' };
  if (drag.touch) {
    // no toque, segurar um pouco antes de arrastar, senão a página não rola
    item.classList.add('pressing');
    drag.timer = setTimeout(() => startDrag(drag.x0, drag.y0), 300);
  } else {
    ev.preventDefault();
  }
});
window.addEventListener('pointermove', ev => {
  if (!drag || ev.pointerId !== drag.id) return;
  if (!drag.active) {
    const moved = Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0);
    if (drag.touch) { if (moved > 10) endDrag(); return; }
    if (moved < 5) return;
    startDrag(ev.clientX, ev.clientY);
  }
  moveDrag(ev.clientX, ev.clientY);
});
window.addEventListener('pointerup', ev => { if (drag && ev.pointerId === drag.id) endDrag(); });
window.addEventListener('pointercancel', ev => { if (drag && ev.pointerId === drag.id) endDrag(); });
document.addEventListener('touchmove', ev => { if (drag && drag.active) ev.preventDefault(); }, { passive: false });
histEl.addEventListener('contextmenu', ev => { if (ev.target.closest('.item')) ev.preventDefault(); });

function startDrag(x, y) {
  const { item } = drag;
  item.classList.remove('pressing');
  const r = item.getBoundingClientRect();
  drag.active = true;
  drag.dx = x - r.left; drag.dy = y - r.top;
  drag.ph = document.createElement('div');
  drag.ph.className = 'item placeholder';
  drag.ph.style.height = r.height + 'px';
  item.before(drag.ph);
  Object.assign(item.style, { width: r.width + 'px', height: r.height + 'px' });
  item.classList.add('dragging');
  if (navigator.vibrate) navigator.vibrate(20);
  moveDrag(x, y);
}

function moveDrag(x, y) {
  const { item, ph } = drag;
  item.style.left = (x - drag.dx) + 'px';
  item.style.top = (y - drag.dy) + 'px';
  const over = document.elementFromPoint(x, y)?.closest('#hist .item');
  if (over && over !== ph && over !== item) {
    const r = over.getBoundingClientRect();
    if (x < r.left + r.width / 2) over.before(ph); else over.after(ph);
  }
  if (y < 50) window.scrollBy(0, -12);
  else if (y > innerHeight - 50) window.scrollBy(0, 12);
}

function endDrag() {
  const d = drag;
  drag = null;
  clearTimeout(d.timer);
  d.item.classList.remove('pressing');
  if (!d.active) return;
  d.ph.replaceWith(d.item);
  d.item.classList.remove('dragging');
  d.item.removeAttribute('style');
  const order = [...histEl.children].map(e => +e.dataset.idx);
  tried = order.map(i => tried[i]);
  renderHistory();
  saveOrder();
}

async function saveOrder() {
  tried.forEach((t, i) => { t.pos = i; });
  const { error } = await sb.rpc('reorder_tried', { ids: tried.map(t => t.id) });
  if (error) toast('Não consegui salvar a ordem: ' + error.message);
}

$('#btnChrono').onclick = () => {
  if (!confirm('Voltar para a ordem das tentativas (mais recente primeiro)? Sua organização será perdida.')) return;
  tried.sort((a, b) => b.n - a.n);
  renderHistory();
  saveOrder();
};

// ---------- importar / exportar ----------
function normalize(e) {
  const pattern = typeof e.pattern === 'string' ? e.pattern : Array.isArray(e.p) ? keyOf(e.p) : null;
  if (!pattern || !/^[1-9](-[1-9]){3,8}$/.test(pattern)) return null;
  const created_at = e.created_at || (e.t ? new Date(e.t).toISOString() : new Date().toISOString());
  return { pattern, ok: !!e.ok, created_at, order: e.n ?? new Date(created_at).getTime() };
}

async function importEntries(entries) {
  const have = new Set(tried.map(t => t.pattern));
  const fresh = entries.filter(e => e && !have.has(e.pattern) && have.add(e.pattern)).sort((a, b) => a.order - b.order);
  if (!fresh.length) return 0;
  let n = nextN();
  const base = tried.length ? Math.max(...tried.map(t => t.pos)) + 1 : 0;
  const rows = fresh.map((e, k) => ({
    pattern: e.pattern, ok: e.ok, created_at: e.created_at, n: n++, pos: base + fresh.length - 1 - k,
  }));
  const { error } = await sb.from('tried').insert(rows);
  if (error) { toast(error.message); return 0; }
  await loadTried();
  return rows.length;
}

$('#btnExport').onclick = () => {
  const data = tried.map(({ pattern, ok, n, source, created_at }) => ({ pattern, ok, n, source, created_at }));
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mapass-historico-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
const fileIn = $('#fileIn');
$('#btnImport').onclick = () => fileIn.click();
fileIn.onchange = async () => {
  const f = fileIn.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const k = await importEntries(data.map(normalize));
    toast(`${k} padrão(ões) importado(s).`);
  } catch { toast('Arquivo inválido.'); }
  fileIn.value = '';
};

function offerLocalImport() {
  let local = [], done = null;
  try {
    local = JSON.parse(localStorage.getItem(LOCAL_KEY)) || [];
    done = localStorage.getItem('mapass-local-imported');
  } catch {}
  if (!local.length || done) return;
  const finish = () => {
    try { localStorage.setItem('mapass-local-imported', '1'); } catch {}
    $('#localBanner').hidden = true;
  };
  $('#localCount').textContent = local.length;
  $('#localBanner').hidden = false;
  $('#btnLocalImport').onclick = async () => {
    const k = await importEntries(local.map(normalize));
    finish();
    toast(`${k} padrão(ões) importado(s) para sua conta.`);
  };
  $('#btnLocalSkip').onclick = finish;
}

// ---------- contatos ----------
async function loadContacts() {
  // as regras do banco só deixam ver você mesmo e seus contatos
  const { data, error } = await sb.from('profiles').select('id, name, email').neq('id', me.id).order('name');
  if (error) return toast(error.message);
  contacts = data;
  renderContacts();
}

function renderContacts() {
  const list = $('#contactList');
  list.innerHTML = '';
  if (!contacts.length) list.innerHTML = '<li class="muted">Nenhum contato ainda.</li>';
  for (const c of contacts) {
    const li = document.createElement('li');
    li.innerHTML = `<span><b>${esc(c.name)}</b> <span class="muted">${esc(c.email)}</span></span>`;
    const rm = document.createElement('button');
    rm.className = 'small'; rm.textContent = 'Remover';
    rm.onclick = async () => {
      if (!confirm(`Remover ${c.name} dos contatos?`)) return;
      const { error } = await sb.from('contacts').delete()
        .or(`and(owner.eq.${me.id},contact.eq.${c.id}),and(owner.eq.${c.id},contact.eq.${me.id})`);
      if (error) return toast(error.message);
      loadContacts();
    };
    li.appendChild(rm);
    list.appendChild(li);
  }
  $('#helperSelect').innerHTML = contacts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('#askForm').hidden = !contacts.length;
  $('#askEmpty').hidden = !!contacts.length;
}

$('#contactForm').onsubmit = async ev => {
  ev.preventDefault();
  const { data, error } = await sb.rpc('add_contact', { contact_email: $('#contactEmail').value });
  if (error) return setStatus($('#contactMsg'), error.message, 'bad');
  setStatus($('#contactMsg'), `${data.name} agora é seu contato.`, 'ok');
  $('#contactEmail').value = '';
  loadContacts();
};

// ---------- pedidos de socorro ----------
const RESULT_LABEL = { ok: '✓ deu certo', falhou: '✗ não deu' };

async function loadRequests() {
  const { data, error } = await sb.from('help_requests').select('*, suggestions(*)')
    .order('created_at', { ascending: false }).limit(30);
  if (error) return toast(error.message);
  data.forEach(r => r.suggestions.sort((a, b) => a.id - b.id));
  // alguém te adicionou depois que a página abriu
  const ids = data.flatMap(r => [r.requester, r.helper]);
  if (ids.some(id => id !== me.id && !contacts.some(c => c.id === id))) await loadContacts();
  diffAndNotify(data);
  requests = data;
  renderSocorro();
}

function diffAndNotify(data) {
  const now = { reqs: new Set(), results: new Map() };
  for (const r of data) {
    now.reqs.add(r.id);
    for (const s of r.suggestions) now.results.set(s.id, s.result);
  }
  if (seen) {
    for (const r of data) {
      if (r.helper === me.id && r.status === 'aberto' && !seen.reqs.has(r.id)) {
        notify('🆘 Pedido de socorro:', `${nameOf(r.requester)} esqueceu o padrão e pediu sua ajuda.`);
        showTab('socorro');
      }
      for (const s of r.suggestions) {
        const before = seen.results.get(s.id);
        if (r.requester === me.id && !seen.results.has(s.id)) {
          notify('📩 Padrão recebido:', `${nameOf(s.author)} te mandou um padrão pra tentar.`);
          showTab('socorro');
        }
        if (s.author === me.id && s.result && seen.results.has(s.id) && before == null) {
          notify(s.result === 'ok' ? '🎉 Deu certo!' : '✗ Não deu:',
            s.result === 'ok' ? `${nameOf(r.requester)} desbloqueou o celular!` : `${nameOf(r.requester)} testou ${s.pattern} e não era esse.`);
        }
      }
    }
  }
  seen = now;
}

function renderSocorro() {
  const mineOpen = requests.filter(r => r.requester === me.id && r.status === 'aberto');
  const forMe = requests.filter(r => r.helper === me.id && r.status === 'aberto');
  const pending = forMe.length + mineOpen.reduce((k, r) => k + r.suggestions.filter(s => !s.result).length, 0);
  $('#sosBadge').textContent = pending;
  $('#sosBadge').hidden = !pending;
  document.title = (pending ? `(${pending}) ` : '') + 'MaPass';
  $('#askCard').hidden = mineOpen.length > 0;
  renderMyRequests(mineOpen);
  renderIncoming(forMe);
  renderPast();
}

function renderMyRequests(list) {
  const box = $('#myReqs');
  box.innerHTML = '';
  for (const r of list) {
    const who = esc(nameOf(r.helper));
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="req-head"><h2>🆘 Seu pedido para ${who} <span class="muted">· ${ago(r.created_at)}</span></h2></div>`;
    const close = document.createElement('button');
    close.className = 'small'; close.textContent = 'Encerrar pedido';
    close.onclick = async () => {
      if (!confirm('Encerrar este pedido de socorro?')) return;
      const { error } = await sb.from('help_requests').update({ status: 'encerrado' }).eq('id', r.id);
      if (error) return toast(error.message);
      loadRequests();
    };
    card.querySelector('.req-head').appendChild(close);
    if (!r.suggestions.length) {
      card.insertAdjacentHTML('beforeend', `<p class="muted">Aguardando ${who} desenhar um padrão… Deixe esta página aberta que ele aparece aqui.</p>`);
    } else {
      const grid = document.createElement('div');
      grid.className = 'sugs';
      [...r.suggestions].reverse().forEach(s => {
        const p = parseKey(s.pattern);
        const it = document.createElement('div');
        it.className = 'sug ' + (s.result === 'ok' ? 'win' : s.result === 'falhou' ? 'fail' : 'pending');
        it.appendChild(miniSvg(p, s.result === 'falhou' ? 'var(--bad)' : s.result === 'ok' ? 'var(--ok)' : 'var(--accent)', true));
        it.insertAdjacentHTML('beforeend', `<div class="seq">${fmtSeq(p)}</div><div class="meta">de ${esc(nameOf(s.author))} · ${ago(s.created_at)}</div>`);
        if (s.result) {
          it.insertAdjacentHTML('beforeend', `<div class="res">${RESULT_LABEL[s.result]}</div>`);
        } else {
          const act = document.createElement('div');
          act.className = 'actions';
          const yes = document.createElement('button');
          yes.className = 'good'; yes.textContent = 'Deu certo ✓';
          yes.onclick = () => answer(s, 'ok');
          const no = document.createElement('button');
          no.className = 'danger'; no.textContent = 'Não deu ✗';
          no.onclick = () => answer(s, 'falhou');
          act.append(yes, no);
          it.appendChild(act);
        }
        grid.appendChild(it);
      });
      card.appendChild(grid);
    }
    box.appendChild(card);
  }
}

async function answer(s, result) {
  if (result === 'ok' && !confirm('Confirmar que esse padrão desbloqueou o celular?')) return;
  const { error } = await sb.from('suggestions').update({ result }).eq('id', s.id);
  if (error) return toast(error.message);
  await Promise.all([loadRequests(), loadTried()]);
  if (result === 'ok') toast('🎉 Boa! Anote o padrão em algum lugar seguro.');
}

$('#askForm').onsubmit = async ev => {
  ev.preventDefault();
  const helper = $('#helperSelect').value;
  if (!helper) return;
  const { error } = await sb.from('help_requests').insert({ helper, message: $('#askMsg').value.trim() });
  if (error) return toast(error.message);
  $('#askMsg').value = '';
  toast(`Pedido enviado para ${nameOf(helper)}. Se der, avise que é pra abrir o MaPass.`);
  loadRequests();
};

// quem está ajudando
const currentHelp = () => requests.find(r => r.id === helpReqId && r.status === 'aberto');
let helpPath = null;

const helpPad = createPad($('#helpPad'), {
  seqEl: $('#helpSeq'),
  onStart: () => {
    helpPath = null;
    $('#btnSend').disabled = true;
    setStatus($('#helpStatus'), 'Desenhando…');
  },
  onFinish: evaluateHelp,
});

function evaluateHelp(p) {
  const r = currentHelp();
  const st = $('#helpStatus');
  if (!r) return;
  if (!p.length) return setStatus(st, 'Desenhe o padrão que você acha que é');
  if (p.length < 4) return setStatus(st, 'Mínimo de 4 pontos (o Android não aceita menos)', 'warn');
  const k = keyOf(p);
  if (helpTried.some(t => t.pattern === k)) return setStatus(st, `${nameOf(r.requester)} já tentou esse.`, 'bad');
  if (r.suggestions.some(s => s.pattern === k)) return setStatus(st, 'Você já mandou esse.', 'bad');
  helpPath = p;
  setStatus(st, 'Padrão novo. Pode enviar!', 'ok');
  $('#btnSend').disabled = false;
}

$('#btnSend').onclick = async () => {
  const r = currentHelp();
  if (!r || !helpPath) return;
  $('#btnSend').disabled = true;
  const { error } = await sb.from('suggestions').insert({ request_id: r.id, pattern: keyOf(helpPath) });
  if (error) return setStatus($('#helpStatus'), 'Não consegui enviar: ' + error.message, 'bad');
  helpPath = null;
  helpPad.clear();
  setStatus($('#helpStatus'), `Enviado! Aguarde ${nameOf(r.requester)} testar. Se ficou em dúvida, pode mandar outro.`, 'ok');
  loadRequests();
};
$('#btnHelpClear').onclick = () => {
  helpPath = null;
  $('#btnSend').disabled = true;
  setStatus($('#helpStatus'), 'Desenhe o padrão que você acha que é');
  helpPad.clear();
};

async function loadHelpTried() {
  const r = currentHelp();
  if (!r) return;
  const { data, error } = await sb.from('tried').select('pattern, ok, n, source').eq('user_id', r.requester)
    .order('n', { ascending: false });
  helpTried = error ? [] : data;
}

async function selectHelp(id) {
  helpReqId = id;
  helpPath = null;
  helpPad.clear();
  $('#btnSend').disabled = true;
  setStatus($('#helpStatus'), 'Desenhe o padrão que você acha que é');
  await loadHelpTried();
  renderHelpPanel();
}

function renderIncoming(list) {
  $('#incoming').hidden = !list.length;
  if (!list.length) { helpReqId = null; return; }
  if (!list.some(r => r.id === helpReqId)) selectHelp(list[0].id);
  else renderHelpPanel();
}

function renderHelpPanel() {
  const r = currentHelp();
  if (!r) return;
  const forMe = requests.filter(x => x.helper === me.id && x.status === 'aberto');
  const chips = $('#helpChips');
  chips.innerHTML = '';
  if (forMe.length > 1) {
    for (const x of forMe) {
      const b = document.createElement('button');
      b.className = 'small' + (x.id === r.id ? ' active' : '');
      b.textContent = `🆘 ${nameOf(x.requester)}`;
      b.onclick = () => selectHelp(x.id);
      chips.appendChild(b);
    }
  }
  const who = nameOf(r.requester);
  $('#helpTitle').textContent = `🆘 ${who} pediu socorro`;
  $('#helpMsg').textContent = (r.message ? `"${r.message}" · ` : '') + ago(r.created_at);
  $('#btnSend').textContent = `Enviar para ${who}`;

  const sugs = $('#helpSugs');
  sugs.innerHTML = '';
  if (!r.suggestions.length) sugs.innerHTML = '<div class="empty">Nada enviado ainda.</div>';
  [...r.suggestions].reverse().forEach(s => {
    const it = document.createElement('div');
    it.className = 'item static' + (s.result === 'ok' ? ' win' : '');
    it.innerHTML = `<div class="n">${s.result ? RESULT_LABEL[s.result] : '⏳ esperando teste'}</div>`;
    it.appendChild(miniSvg(parseKey(s.pattern), s.result === 'falhou' ? 'var(--bad)' : s.result === 'ok' ? 'var(--ok)' : 'var(--accent)'));
    it.insertAdjacentHTML('beforeend', `<div class="meta">${s.pattern}</div>`);
    sugs.appendChild(it);
  });

  $('#helpTriedTitle').textContent = `${who} já tentou (${helpTried.length})`;
  const tg = $('#helpTried');
  tg.innerHTML = '';
  if (!helpTried.length) tg.innerHTML = '<div class="empty">Nenhum registrado ainda.</div>';
  for (const t of helpTried) {
    const it = triedItem(t);
    it.classList.add('static');
    tg.appendChild(it);
  }
}

function renderPast() {
  const past = requests.filter(r => r.status !== 'aberto').slice(0, 10);
  $('#pastCard').hidden = !past.length;
  $('#pastReqs').innerHTML = past.map(r => {
    const mine = r.requester === me.id;
    const other = esc(nameOf(mine ? r.helper : r.requester));
    const st = r.status === 'resolvido' ? '✓ resolvido' : 'encerrado';
    return `<li><span>${mine ? `Você pediu para ${other}` : `${other} pediu para você`} · ${r.suggestions.length} padrão(ões) · <b>${st}</b></span>
      <span class="muted">${ago(r.created_at)}</span></li>`;
  }).join('');
}

// ---------- início ----------
if (!configured) {
  $('#setup').hidden = false;
} else {
  // o callback não pode esperar chamadas do supabase direto, por isso o setTimeout
  sb.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => (session ? boot(session.user) : logoutUI()), 0);
  });
}
