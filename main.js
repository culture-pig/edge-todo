// 贴边待办 · 主进程
// 负责：条+面板双窗口、四边吸附、悬停展开、托盘、全局快捷键、开机自启、到点提醒、番茄钟计时、本地数据
const { app, BrowserWindow, Tray, Menu, globalShortcut, Notification, screen, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const BAR_L = 120;  // 收纳长条长度（比原 280 窄）
const BAR_T = 32;   // 收纳长条厚度
const PANEL_W = 340;
const PANEL_H = 470;
const POMO_MS = 25 * 60 * 1000;

let barWin = null;
let panelWin = null;
let tray = null;
let settings = { edge: 'top', offset: null, monitor: null, autoStart: true, openMode: 'hover', historyDays: 1 };
let todos = [];
const notifiedIds = new Set(); // 本次会话已提醒过的待办

let expanded = false;   // 面板是否展开
let animating = false;  // 正在播放滑出/滑入动画
let hoverTicks = 0;     // 光标在条上连续停留的轮询次数（防误触）
let leaveSince = 0;     // 光标离开面板的时刻
let suppressUntil = 0;  // 拖拽换边后暂时不自动展开

let dragging = false;   // 用户正在拖动窗口
let dragWin = null;     // 被拖动的是哪个窗口
let needsSnap = false;  // 拖动结束后需要重新吸附
let manualDrag = null;  // 主进程手动拖动状态 { win, offX, offY, timer, startX, startY }

let pomo = null;        // { todoId, endAt }
let pomoTimer = null;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dueTs = (t) => new Date(t.due).getTime();

/* ---------------- 本地数据 ---------------- */
function loadAll() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { todos = JSON.parse(fs.readFileSync(TODOS_FILE, 'utf8')) || []; } catch { todos = []; }
  try { settings = Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}); } catch {}
  // 启动时把已过期的待办标记为“已提醒”，避免一开机弹一堆旧通知
  const now = Date.now();
  for (const t of todos) if (!t.done && t.due && dueTs(t) <= now) notifiedIds.add(t.id);
}
function saveTodos() { fs.writeFileSync(TODOS_FILE, JSON.stringify(todos, null, 2)); }
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }

/* ---------------- 几何计算 ---------------- */
function workArea() {
  try {
    if (settings.monitor) {
      const m = screen.getDisplayMatching(settings.monitor);
      if (m) return m.workArea;
    }
  } catch {}
  return screen.getPrimaryDisplay().workArea;
}

function barRect() {
  const wa = workArea();
  const horizontal = settings.edge === 'top' || settings.edge === 'bottom';
  const span = horizontal ? wa.width : wa.height;
  const off = clamp(settings.offset == null ? Math.round((span - BAR_L) / 2) : settings.offset, 0, Math.max(0, span - BAR_L));
  switch (settings.edge) {
    case 'top':    return { x: wa.x + off, y: wa.y, width: BAR_L, height: BAR_T };
    case 'bottom': return { x: wa.x + off, y: wa.y + wa.height - BAR_T, width: BAR_L, height: BAR_T };
    case 'left':   return { x: wa.x, y: wa.y + off, width: BAR_T, height: BAR_L };
    default:       return { x: wa.x + wa.width - BAR_T, y: wa.y + off, width: BAR_T, height: BAR_L };
  }
}

function panelRect() {
  const wa = workArea();
  const b = barRect();
  let x, y;
  if (settings.edge === 'top' || settings.edge === 'bottom') {
    x = clamp(Math.round(b.x + b.width / 2 - PANEL_W / 2), wa.x, wa.x + wa.width - PANEL_W);
    y = settings.edge === 'top' ? wa.y : wa.y + wa.height - PANEL_H;
  } else {
    y = clamp(Math.round(b.y + b.height / 2 - PANEL_H / 2), wa.y, wa.y + wa.height - PANEL_H);
    x = settings.edge === 'left' ? wa.x : wa.x + wa.width - PANEL_W;
  }
  return { x, y, width: PANEL_W, height: PANEL_H };
}

/* ---------------- 窗口 ---------------- */
function safeBounds(win, r) { win.setBounds(r); }
function send(win, ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }
function sendTodos() { send(panelWin, 'todos:changed', todos); }
function broadcast(ch, payload) { send(barWin, ch, payload); send(panelWin, ch, payload); }

function createWindows() {
  const opts = {
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false }
  };
  barWin = new BrowserWindow({ ...opts, width: BAR_L, height: BAR_T });
  barWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), { search: 'role=bar' });
  barWin.setAlwaysOnTop(true, 'screen-saver');

  panelWin = new BrowserWindow({ ...opts, width: PANEL_W, height: PANEL_H });
  panelWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), { search: 'role=panel' });
  panelWin.setAlwaysOnTop(true, 'screen-saver');

  // 防止 Alt+F4 把窗口关掉导致功能残缺：一律拦下，退出请用托盘菜单
  barWin.on('close', (e) => e.preventDefault());
  panelWin.on('close', (e) => { e.preventDefault(); if (expanded) collapse(); else panelWin.hide(); });

  barWin.once('ready-to-show', () => {
    safeBounds(barWin, barRect());
    barWin.showInactive();
  });
}

/* ---------------- 悬停展开 / 收回 ---------------- */
const within = (p, r, pad = 0) =>
  p.x >= r.x - pad && p.x <= r.x + r.width + pad &&
  p.y >= r.y - pad && p.y <= r.y + r.height + pad;

function startPolling() {
  setInterval(() => {
    if (manualDrag) { hoverTicks = 0; return; }   // 手动拖动中，交给 drag:end 收尾
    if (animating || suppressUntil > Date.now()) { hoverTicks = 0; return; }

    const p = screen.getCursorScreenPoint();
    if (expanded) {
      const stay = (panelWin.isVisible() && within(p, panelWin.getBounds())) ||
                   (barWin.isVisible() && within(p, barWin.getBounds()));
      if (stay) leaveSince = 0;
      else if (!leaveSince) leaveSince = Date.now();
      else if (Date.now() - leaveSince > 500) { leaveSince = 0; collapse(); }
    } else {
      leaveSince = 0;
      if (barWin.isVisible() && settings.openMode === 'hover' && within(p, barWin.getBounds(), 8)) {
        if (++hoverTicks >= 2) { hoverTicks = 0; expand(false); } // 连续两轮(~240ms)才展开，防误触
      } else hoverTicks = 0;
    }
  }, 120);
}

function expand(focus) {
  if (expanded || animating) return;
  expanded = true;
  animating = true;
  safeBounds(panelWin, panelRect());
  send(panelWin, 'dock', settings.edge);
  send(panelWin, 'panel', focus ? 'show-focus' : 'show');
  panelWin.showInactive();
  if (focus) panelWin.focus();
  barWin.hide();
  setTimeout(() => { animating = false; }, 280);
}

function collapse() {
  if (!expanded || animating) return;
  animating = true;
  send(panelWin, 'panel', 'hide');
  setTimeout(finishCollapse, 450); // 兜底：动画回执丢了也能收回
}

function finishCollapse() {
  if (!expanded) return;
  expanded = false;
  panelWin.hide();
  safeBounds(barWin, barRect());
  send(barWin, 'dock', settings.edge);
  barWin.showInactive();
  animating = false;
}

function toggle(focus = true) { if (expanded) collapse(); else expand(focus); }

/* ---------------- 手动拖动（CSS 拖拽区会吞真实点击，改用光标跟随） ---------------- */
ipcMain.on('drag:begin', (_e, winName, cur) => {
  const win = winName === 'panel' ? panelWin : barWin;
  if (!win || win.isDestroyed() || manualDrag) return;
  const b = win.getBounds();
  manualDrag = { win, offX: cur.x - b.x, offY: cur.y - b.y, startX: cur.x, startY: cur.y, timer: null };
  dragging = true; dragWin = win; needsSnap = true;
  manualDrag.timer = setInterval(() => {
    if (!manualDrag) return;
    const p = screen.getCursorScreenPoint();
    safeBounds(win, { x: p.x - manualDrag.offX, y: p.y - manualDrag.offY, width: b.width, height: b.height });
  }, 16);
});

ipcMain.on('drag:end', () => {
  if (!manualDrag) return;
  clearInterval(manualDrag.timer);
  const d = manualDrag;
  manualDrag = null;
  dragging = false;
  const p = screen.getCursorScreenPoint();
  const moved = Math.hypot(p.x - d.startX, p.y - d.startY);
  if (needsSnap) {
    needsSnap = false;
    if (moved > 4) doSnap();   // 位移过小视为单击，不吸附
  }
});

/* ---------------- 四边吸附 ---------------- */
function doSnap() {
  const win = (dragWin === panelWin && panelWin.isVisible()) ? panelWin : barWin;
  const r = win.getBounds();
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const d = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) }).workArea;

  const dist = { top: cy - d.y, bottom: d.y + d.height - cy, left: cx - d.x, right: d.x + d.width - cx };
  let edge = 'top', best = Infinity;
  for (const k in dist) if (dist[k] < best) { best = dist[k]; edge = k; }

  settings.edge = edge;
  settings.monitor = { x: d.x, y: d.y, width: d.width, height: d.height };
  const horizontal = edge === 'top' || edge === 'bottom';
  const along = horizontal ? cx - d.x : cy - d.y;
  settings.offset = clamp(Math.round(along - BAR_L / 2), 0, Math.max(0, (horizontal ? d.width : d.height) - BAR_L));
  saveSettings();
  applyLayout(expanded);
  suppressUntil = Date.now() + 700; // 刚拖完别立刻自动弹开
}

function applyLayout(keepPanel) {
  safeBounds(barWin, barRect());
  broadcast('dock', settings.edge);
  if (keepPanel && expanded) safeBounds(panelWin, panelRect());
}

/* ---------------- 历史过期清理（每条从完成时刻独立倒计时） ---------------- */
function purgeHistory() {
  const keepMs = (settings.historyDays || 1) * 86400000;
  const now = Date.now();
  const before = todos.length;
  todos = todos.filter((t) => !t.done || !t.completedAt || new Date(t.completedAt).getTime() + keepMs > now);
  if (todos.length !== before) { console.log('[history] purged', before - todos.length); saveTodos(); sendTodos(); }
}

/* ---------------- 到点提醒 ---------------- */
function startReminders() {
  purgeHistory();
  setInterval(() => {
    purgeHistory();
    const now = Date.now();
    for (const t of todos) {
      if (t.done || !t.due || notifiedIds.has(t.id)) continue;
      if (dueTs(t) <= now) { notifiedIds.add(t.id); notifyTodo(t); }
    }
  }, 30000);
}

function notifyTodo(t) {
  console.log('[reminder] fired:', t.text);
  send(barWin, 'flash');
  if (panelWin.isVisible()) send(panelWin, 'flash-todo', t.id);
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: '⏰ 待办提醒', body: t.text });
  n.on('click', () => { expand(true); send(panelWin, 'focus-todo', t.id); });
  n.show();
}

/* ---------------- 番茄钟（主进程计时，窗口隐藏也不丢） ---------------- */
function stopPomoTimer() { if (pomoTimer) { clearInterval(pomoTimer); pomoTimer = null; } }

ipcMain.handle('pomo:start', (_e, todoId) => {
  stopPomoTimer();
  pomo = { todoId: todoId || null, endAt: Date.now() + POMO_MS };
  broadcast('pomo:tick', { remaining: POMO_MS, todoId: pomo.todoId });
  pomoTimer = setInterval(() => {
    if (!pomo) return stopPomoTimer();
    const remaining = Math.max(0, pomo.endAt - Date.now());
    broadcast('pomo:tick', { remaining, todoId: pomo.todoId });
    if (remaining <= 0) finishPomo(true);
  }, 1000);
  return true;
});

ipcMain.handle('pomo:stop', () => { finishPomo(false); return true; });

function finishPomo(completed) {
  stopPomoTimer();
  const p = pomo;
  pomo = null;
  if (completed && p && p.todoId) {
    const t = todos.find((x) => x.id === p.todoId);
    if (t) { t.pomodoros = (t.pomodoros || 0) + 1; saveTodos(); sendTodos(); }
  }
  broadcast('pomo:done', { completed, todoId: p ? p.todoId : null });
  if (completed && Notification.isSupported()) {
    const n = new Notification({ title: '🍅 番茄钟完成', body: '专注 25 分钟结束，休息 5 分钟吧' });
    n.on('click', () => expand(true));
    n.show();
  }
}

/* ---------------- 待办数据 IPC ---------------- */
ipcMain.handle('get-state', () => ({ edge: settings.edge, openMode: settings.openMode, historyDays: settings.historyDays }));
ipcMain.handle('todos:list', () => todos);
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return false;
  if (patch.openMode === 'hover' || patch.openMode === 'click') settings.openMode = patch.openMode;
  if ([1, 3, 7, 30].includes(patch.historyDays)) settings.historyDays = patch.historyDays;
  saveSettings();
  send(panelWin, 'settings:changed', { openMode: settings.openMode, historyDays: settings.historyDays });
  return true;
});

ipcMain.handle('todos:add', (_e, { text, due, priority }) => {
  text = String(text || '').trim().slice(0, 200);
  if (!text) return null;
  const t = {
    id: crypto.randomUUID(), text, done: false, due: due || null,
    priority: ['high', 'mid', 'low'].includes(priority) ? priority : 'low',
    createdAt: new Date().toISOString(), completedAt: null, pomodoros: 0
  };
  todos.unshift(t);
  saveTodos(); sendTodos();
  return t;
});

ipcMain.handle('todos:toggle', (_e, id) => {
  const t = todos.find((x) => x.id === id);
  if (!t) return false;
  t.done = !t.done;
  t.completedAt = t.done ? new Date().toISOString() : null;
  saveTodos(); sendTodos();
  return t.done;
});

ipcMain.handle('todos:remove', (_e, id) => {
  todos = todos.filter((x) => x.id !== id);
  if (pomo && pomo.todoId === id) finishPomo(false);
  saveTodos(); sendTodos();
  return true;
});

ipcMain.handle('todos:update', (_e, id, patch) => {
  const t = todos.find((x) => x.id === id);
  if (!t) return false;
  if (patch && typeof patch.text === 'string' && patch.text.trim()) t.text = patch.text.trim().slice(0, 200);
  if (patch && 'due' in patch) t.due = patch.due || null;
  if (patch && ['high', 'mid', 'low'].includes(patch.priority)) t.priority = patch.priority;
  saveTodos(); sendTodos();
  return true;
});

ipcMain.on('bar:click', () => expand(false));
ipcMain.on('panel:collapse', () => collapse());
ipcMain.on('panel:hidden', () => finishCollapse());

/* ---------------- 托盘 / 快捷键 / 自启 ---------------- */
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 32 });
  tray = new Tray(img);
  const menu = Menu.buildFromTemplate([
    { label: '展开 / 收起（Alt+Q）', click: () => toggle(true) },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: !!settings.autoStart, click: (mi) => setAutoStart(mi.checked) },
    { label: '退出', click: () => app.exit(0) }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('贴边待办');
  tray.on('click', () => toggle(true));
}

function setAutoStart(on) {
  settings.autoStart = !!on;
  saveSettings();
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: on });
  } else {
    // 开发模式：注册的是 electron.exe + 项目路径，正式效果以打包后为准
    app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: [path.resolve(__dirname)] });
  }
}

function registerShortcut() {
  const ok = globalShortcut.register('Alt+Q', () => toggle(true));
  if (!ok) console.warn('[edge-todo] Alt+Q 注册失败，可能被其他程序占用');
}

/* ---------------- 启动 ---------------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => toggle(true));
  app.whenReady().then(() => {
    app.setAppUserModelId('com.sunpigig.edge-todo');
    loadAll();
    createWindows();
    createTray();
    registerShortcut();
    setAutoStart(settings.autoStart);
    startPolling();
    startReminders();
    screen.on('display-metrics-changed', () => { settings.monitor = null; applyLayout(expanded); });
    screen.on('display-removed', () => { settings.monitor = null; applyLayout(expanded); });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
