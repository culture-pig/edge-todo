// 贴边待办 · 预加载桥：把主进程能力安全暴露给页面
const { contextBridge, ipcRenderer } = require('electron');

// 允许页面订阅的主进程推送
const PUSH = ['todos:changed', 'dock', 'panel', 'flash', 'flash-todo', 'focus-todo', 'pomo:tick', 'pomo:done', 'settings:changed'];

contextBridge.exposeInMainWorld('api', {
  state: () => ipcRenderer.invoke('get-state'),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  list: () => ipcRenderer.invoke('todos:list'),
  add: (t) => ipcRenderer.invoke('todos:add', t),
  toggle: (id) => ipcRenderer.invoke('todos:toggle', id),
  remove: (id) => ipcRenderer.invoke('todos:remove', id),
  update: (id, patch) => ipcRenderer.invoke('todos:update', id, patch),
  pomoStart: (todoId) => ipcRenderer.invoke('pomo:start', todoId),
  pomoStop: () => ipcRenderer.invoke('pomo:stop'),
  expand: () => ipcRenderer.send('bar:click'),
  dragStart: (win, cur) => ipcRenderer.send('drag:begin', win, cur),
  dragEnd: () => ipcRenderer.send('drag:end'),
  collapse: () => ipcRenderer.send('panel:collapse'),
  hidden: () => ipcRenderer.send('panel:hidden'),
  on: (ch, cb) => { if (PUSH.includes(ch)) ipcRenderer.on(ch, (_e, v) => cb(v)); }
});
