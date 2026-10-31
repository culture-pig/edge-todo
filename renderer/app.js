// 贴边待办 · 渲染逻辑（bar / panel 两种角色共用一个文件）
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');

const role = new URLSearchParams(location.search).get('role') || 'bar';
document.body.dataset.role = role;

let todos = [];
let pomoState = { running: false, remaining: 0, todoId: null };
let view = 'list';   // 面板视图：list 待办 | history 历史 | settings 设置
let uiSettings = { openMode: 'hover', historyDays: 1 };

/* ---------------- 工具 ---------------- */
function endOfToday() { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); }
function isOverdue(t) { return !t.done && t.due && new Date(t.due).getTime() < Date.now(); }

function fmtDue(iso) {
  const d = new Date(iso);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `今天 ${hm}`;
  const tm = new Date(now); tm.setDate(tm.getDate() + 1);
  if (d.getFullYear() === tm.getFullYear() && d.getMonth() === tm.getMonth() && d.getDate() === tm.getDate()) return `明天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function fmtMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
function groupOf(t) {
  if (t.done) return 'done';
  if (!t.due || new Date(t.due).getTime() <= endOfToday()) return 'today';
  return 'later';
}

/* ---------------- 收纳条 ---------------- */
function initBar() {
  $('#app').innerHTML = '<div class="bar" id="bar"><div class="dot"></div></div>';
  // 圆点点击展开（点击模式下）；条身按下启动主进程手动拖动
  $('#bar').addEventListener('click', (e) => { if (e.target.closest('.dot')) api.expand(); });
  $('#bar').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.dot')) return;
    api.dragStart('bar', { x: e.screenX, y: e.screenY });
  });
  window.addEventListener('mouseup', () => api.dragEnd());
  api.on('flash', () => {
    const bar = $('#bar');
    bar.classList.remove('flash');
    void bar.offsetWidth; // 重置动画
    bar.classList.add('flash');
  });
}

/* ---------------- 面板 ---------------- */
function initPanel() {
  $('#app').innerHTML = `
    <div class="panel slide out" id="panel">
      <div class="p-head">
        <button class="p-tab tab-main" id="tabList" title="待办列表">待办<span class="p-count" id="count"></span></button>
        <button class="p-tab" id="btnHistory" title="历史">🕐</button>
        <button class="p-tab" id="btnSettings" title="设置">⚙</button>
        <span class="p-pomo" id="pomoHead">🍅 <span id="pomoTime"></span></span>
        <button class="p-close" id="btnHide" title="收起（Esc）">—</button>
      </div>
      <div class="p-list" id="list"></div>
      <div class="p-composer">
        <div class="row1">
          <input type="text" id="inpText" placeholder="新待办，回车添加…" maxlength="200">
          <button class="add" id="btnAdd" title="添加">＋</button>
        </div>
        <div class="row2">
          <input type="datetime-local" id="inpDue" title="提醒时间（可选）">
          <span class="prio" id="prioPick" title="重要程度">
            <button class="pr pr-h" data-prio="high" title="重要：高"><i></i>高</button>
            <button class="pr pr-m" data-prio="mid" title="重要：中"><i></i>中</button>
            <button class="pr pr-l on" data-prio="low" title="重要：低"><i></i>低</button>
          </span>
        </div>
      </div>
    </div>`;

  const inp = $('#inpText'), due = $('#inpDue');
  let newPrio = 'low';   // 新待办的重要程度，默认低
  const addTodo = async () => {
    const text = inp.value.trim();
    if (!text) return inp.focus();
    const d = due.value ? new Date(due.value) : null;
    await api.add({ text, due: d && !isNaN(d) ? d.toISOString() : null, priority: newPrio });
    inp.value = ''; due.value = ''; inp.focus();
  };
  $('#btnAdd').onclick = addTodo;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTodo(); });
  $('#prioPick').addEventListener('click', (e) => {
    const b = e.target.closest('.pr');
    if (!b) return;
    newPrio = b.dataset.prio;
    $$('#prioPick .pr').forEach((x) => x.classList.toggle('on', x === b));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.tagName !== 'INPUT') api.collapse();
  });

  $('#btnHide').onclick = () => api.collapse();
  // 头部空白处按下启动手动拖动（按钮除外）；CSS 拖拽区会吞真实点击，已弃用
  $('.p-head').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    api.dragStart('panel', { x: e.screenX, y: e.screenY });
  });
  window.addEventListener('mouseup', () => api.dragEnd());
  // 三个固定页签：点哪个进哪个，回待办点「待办」即达（非 toggle）
  $('#tabList').onclick = () => { view = 'list'; render(); };
  $('#btnHistory').onclick = () => { view = 'history'; render(); };
  $('#btnSettings').onclick = () => { view = 'settings'; render(); };
  api.settingsGet().then((s) => { uiSettings = { openMode: s.openMode || 'hover', historyDays: s.historyDays || 1 }; if (view === 'settings') render(); });
  api.on('settings:changed', (s) => { uiSettings = s; if (view === 'settings') render(); });
  // 历史剩余时间每分钟刷新
  setInterval(() => { if (view === 'history') render(); }, 60000);
  $('#list').addEventListener('click', onListClick);
  $('#list').addEventListener('dblclick', onListDblClick);

  api.on('todos:changed', (list) => { todos = list || []; render(); });
  api.on('flash-todo', (id) => highlightRow(id));
  api.on('focus-todo', (id) => highlightRow(id, true));

  api.on('panel', (msg) => {
    const p = $('#panel');
    if (msg === 'show' || msg === 'show-focus') {
      p.classList.remove('out'); p.classList.add('in');
      if (msg === 'show-focus') setTimeout(() => inp.focus(), 230);
    } else if (msg === 'hide') {
      p.classList.remove('in'); p.classList.add('out');
      setTimeout(() => api.hidden(), 300); // 动画播完通知主进程
    }
  });

  api.on('pomo:tick', (d) => { pomoState = { running: d.remaining > 0, remaining: d.remaining, todoId: d.todoId }; updatePomoUI(); });
  api.on('pomo:done', () => { pomoState = { running: false, remaining: 0, todoId: null }; updatePomoUI(); });

  (async () => { todos = await api.list(); render(); })();
}

/* ---------------- 渲染 ---------------- */
function mount(list, html) {
  list.innerHTML = html;
  [...list.children].forEach((el, i) => el.style.setProperty('--i', Math.min(i, 12)));  // 行错峰入场
}

function render() {
  const list = $('#list');
  $('#tabList').classList.toggle('on', view === 'list');
  $('#btnHistory').classList.toggle('on', view === 'history');
  $('#btnSettings').classList.toggle('on', view === 'settings');
  if (view === 'settings') { renderSettings(list); return; }
  if (view === 'history') { renderHistory(list); return; }

  const groups = { today: [], later: [] };
  for (const t of todos) if (!t.done) groups[groupOf(t)].push(t);
  // 组内排序：重要程度 高→中→低；同档按创建先后，先创建的在前
  const prioRank = { high: 0, mid: 1, low: 2 };
  const byPrio = (a, b) =>
    (prioRank[a.priority || 'low'] - prioRank[b.priority || 'low']) ||
    (new Date(a.createdAt) - new Date(b.createdAt));
  groups.today.sort(byPrio);
  groups.later.sort(byPrio);

  const active = groups.today.length + groups.later.length;
  $('#count').textContent = active ? `${active}` : '';
  let html = '';

  const sec = (title, arr) => !arr.length ? '' : `
    <div class="group-title">${title}<span class="g-n">(${arr.length})</span></div>` +
    arr.map(row).join('');

  html += sec('今日', groups.today);
  html += sec('以后', groups.later);
  if (!html) html = `
    <div class="empty"><div class="empty-ic">🕊️</div>
      <div class="empty-tx">还没有待办</div>
      <div class="empty-sub">在下方输入，回车添加</div></div>`;
  mount(list, html);
  updatePomoUI();
}

/* 历史视图：已完成的待办，每条独立倒计时 */
function renderHistory(list) {
  const done = todos.filter((t) => t.done)
    .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0));
  const active = todos.filter((t) => !t.done).length;
  $('#count').textContent = active ? `${active}` : '';
  let html = done.length
    ? `<div class="group-title">已完成<span class="g-n">(${done.length})</span><button class="g-clear" data-act="clear-history">清空</button></div>`
      + done.map(histRow).join('')
    : `<div class="empty"><div class="empty-ic">🗂️</div>
      <div class="empty-tx">暂无历史</div>
      <div class="empty-sub">完成的待办会在这里保留 ${uiSettings.historyDays} 天</div></div>`;
  mount(list, html);
}

function histRow(t) {
  const keepMs = (uiSettings.historyDays || 1) * 86400000;
  const doneAt = new Date(t.completedAt || t.createdAt || 0).getTime();
  const left = fmtLeft(keepMs - (Date.now() - doneAt));
  return `
  <div class="todo done hist" data-id="${t.id}">
    <span class="h-ck" data-act="toggle" data-id="${t.id}" title="取消完成，回到待办">✓</span>
    <div class="h-body">
      <div class="txt">${esc(t.text)}</div>
      <div class="h-meta">完成于 ${fmtDue(t.completedAt || t.createdAt)} · ${left}后自动删除</div>
    </div>
    <button class="h-del" data-act="del" data-id="${t.id}" title="删除">✕</button>
  </div>`;
}

function fmtLeft(ms) {
  if (ms <= 0) return '即将';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} 小时`;
  return `${Math.round(h / 24)} 天`;
}

/* 设置视图：展开方式 + 历史保留期 */
function renderSettings(list) {
  const modeBtn = (m, label, desc) => `
    <button class="opt ${uiSettings.openMode === m ? 'on' : ''}" data-act="set-open" data-val="${m}">
      <b>${label}</b><i>${desc}</i>
    </button>`;
  const dayBtn = (d) => `<button class="day ${uiSettings.historyDays === d ? 'on' : ''}" data-act="set-days" data-val="${d}">${d} 天</button>`;
  mount(list, `
    <div class="settings">
      <div class="set-title">展开方式</div>
      <div class="opt-row">${modeBtn('hover', '悬停出现', '鼠标停在长条上自动展开')}${modeBtn('click', '点击出现', '点击长条中央圆点展开')}</div>
      <div class="set-title">历史保留期</div>
      <div class="day-row">${[1, 3, 7, 30].map(dayBtn).join('')}</div>
      <div class="set-note">每条待办从完成时刻起独立计时，到期自动删除</div>
    </div>`);
}

function row(t) {
  const overdue = isOverdue(t);
  const running = pomoState.running && pomoState.todoId === t.id;
  const left = running ? `<span class="pomo-left" data-id="${t.id}">${fmtMs(pomoState.remaining)}</span>` : '';
  const pomoBtn = t.done ? '' :
    `<button data-act="pomo" data-id="${t.id}">${running ? '■' : '▶'}</button>`;
  const snooze = overdue ? `<button data-act="snooze" data-id="${t.id}">改明天</button>` : '';
  const pomoBadge = t.pomodoros ? `<span class="pomo-badge" title="完成番茄数">🍅${t.pomodoros}</span>` : '';
  const pc = t.done ? '' : (t.priority === 'high' ? 'p-high' : t.priority === 'mid' ? 'p-mid' : '');
  const cur = t.priority || 'low';
  const prioEdit = t.done ? '' : `
    <span class="prio-edit" title="重要程度">
      <button data-act="prio" data-val="high" data-id="${t.id}" class="pe-h ${cur === 'high' ? 'cur' : ''}" title="设为高"></button>
      <button data-act="prio" data-val="mid" data-id="${t.id}" class="pe-m ${cur === 'mid' ? 'cur' : ''}" title="设为中"></button>
      <button data-act="prio" data-val="low" data-id="${t.id}" class="pe-l ${cur === 'low' ? 'cur' : ''}" title="设为低"></button>
    </span>`;
  return `
  <div class="todo ${t.done ? 'done' : ''} ${running ? 'running' : ''} ${pc}" data-id="${t.id}">
    <div class="ck" data-act="toggle" data-id="${t.id}" title="完成/取消完成"></div>
    <span class="txt" data-id="${t.id}" title="双击编辑">${esc(t.text)}</span>
    ${pomoBadge}
    ${t.due ? `<span class="due ${overdue ? 'overdue' : ''}" title="提醒时间">${fmtDue(t.due)}</span>` : ''}
    <span class="act">${left}${prioEdit}${pomoBtn}${snooze}<button data-act="del" data-id="${t.id}" title="删除">✕</button></span>
  </div>`;
}

function updatePomoUI() {
  const head = $('#pomoHead');
  if (pomoState.running) {
    head.classList.add('on');
    $('#pomoTime').textContent = fmtMs(pomoState.remaining);
    $$('[data-id][class*="pomo-left"]').forEach((el) => {
      if (el.dataset.id === pomoState.todoId) el.textContent = fmtMs(pomoState.remaining);
    });
  } else {
    head.classList.remove('on');
  }
}

function highlightRow(id, scroll) {
  const el = $(`.todo[data-id="${id}"]`);
  if (!el) return;
  el.classList.remove('flash-todo'); void el.offsetWidth;
  el.classList.add('flash-todo');
  if (scroll) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------------- 交互 ---------------- */
function onListClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'toggle') api.toggle(id);
  else if (act === 'del') api.remove(id);
  else if (act === 'pomo') pomoState.running ? api.pomoStop() : api.pomoStart(id);
  else if (act === 'prio') api.update(id, { priority: btn.dataset.val });
  else if (act === 'set-open') api.settingsSet({ openMode: btn.dataset.val });
  else if (act === 'set-days') api.settingsSet({ historyDays: +btn.dataset.val });
  else if (act === 'clear-history') todos.filter((t) => t.done).forEach((t) => api.remove(t.id));
  else if (act === 'snooze') {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    api.update(id, { due: d.toISOString() });
  } else if (act === 'clear-done') todos.filter((t) => t.done).forEach((t) => api.remove(t.id));
}

function onListDblClick(e) {
  const span = e.target.closest('.txt');
  if (!span) return;
  const id = span.dataset.id;
  const t = todos.find((x) => x.id === id);
  if (!t || t.done) return;
  const input = document.createElement('input');
  input.value = t.text;
  input.maxLength = 200;
  span.replaceWith(input);
  input.focus(); input.select();
  const done = (save) => {
    if (save) {
      const v = input.value.trim();
      if (v && v !== t.text) api.update(id, { text: v });
    }
    render();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') done(true);
    else if (ev.key === 'Escape') done(false);
    ev.stopPropagation();
  });
  input.addEventListener('blur', () => done(true));
}

/* ---------------- 启动 ---------------- */
(async () => {
  const st = await api.state();
  document.body.dataset.edge = st.edge;
  api.on('dock', (edge) => { document.body.dataset.edge = edge; });
  if (role === 'bar') initBar(); else initPanel();
})();
