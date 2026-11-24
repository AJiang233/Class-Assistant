/**
 * 视图历史（安卓返回键）的回归测试。
 *
 * 门户是单页壳：切视图只是翻一下 iframe 的 hidden，浏览器历史里不留记录。安卓壳的
 * MainActivity.onKeyDown 只在 webView.canGoBack() 为真时才 goBack()，否则把返回键
 * 交还系统 —— 表现就是「在待办页按返回直接退出到桌面」。index.js 于是把每次切换写进
 * history，让返回键回到上一个视图，主页作为栈底。
 *
 * index.js 是带副作用的 IIFE（启动就要读表单、拉日历），整份跑不起来，所以这里把
 * 「===== 视图历史 =====」那段源码切出来，放进带假 window / history 的沙箱执行，
 * 断言它压栈、去重、回退的真实行为；再补三条接线断言（首屏顺序、switchView 末尾补记录、
 * currentView 必须在初始化之前赋值）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../../assets/js/index.js'), 'utf8');

const START = 'var VIEW_HISTORY_KEY';
const END = "window.addEventListener('popstate', onHistoryPop);";

/** 切出视图历史那一段（标记被改名时直接报错，而不是悄悄测了个空壳） */
function historySource() {
  const a = SRC.indexOf(START);
  const b = SRC.indexOf(END);
  assert.ok(a >= 0 && b > a, '找不到视图历史代码段：标记被改名或搬走了，测试要跟着改');
  return SRC.slice(a, b + END.length);
}

/**
 * 把视图历史代码放进沙箱：假 localStorage / history / window。
 * switchView 只记下调用参数，并把沙箱里的 currentView 改成新视图（模拟真实实现）。
 */
function load(opts = {}) {
  const calls = [];
  const pushes = [];
  const replaces = [];
  const listeners = {};
  const store = new Map();
  if (opts.authed !== false) store.set('ca_token', 't');

  const sb = {
    currentView: opts.currentView || 'home',
    LS_TOKEN: 'ca_token',
    SWIPE_PAGES: ['home', 'notices', 'activities', 'todos', 'academic', 'account', 'admin'],
    canManagePanel: () => !!opts.canManage,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null) },
    history: {
      state: undefined,
      replaceState(state, title, url) { this.state = state; replaces.push({ state, url }); },
      pushState(state, title, url) { this.state = state; pushes.push({ state, url }); }
    },
    switchView(key, dir) {
      calls.push({ key, dir });
      sb.currentView = key;
    }
  };
  const search = opts.search || '';
  sb.window = {
    location: { pathname: '/index.html', hash: '', href: 'http://class.test/index.html' + search },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
  };

  vm.createContext(sb);
  vm.runInContext(historySource(), sb);
  return { sb, calls, pushes, replaces, listeners };
}

test('首屏把入口记录钉成主页，不带深链时不额外压记录', () => {
  const t = load();
  t.sb.bootViewHistory('home');
  assert.equal(t.replaces.length, 1);
  assert.equal(t.replaces[0].state.caView, 'home');
  assert.equal(t.replaces[0].url, '/index.html');
  assert.equal(t.pushes.length, 0);
  assert.equal(t.sb.history.state.caView, 'home');
});

test('深链进来：地址原样保留（含 id），按一次返回回主页', () => {
  const t = load({ search: '?view=notices&id=3' });
  t.sb.bootViewHistory('notices');
  assert.equal(t.replaces.length, 1);
  assert.equal(t.replaces[0].url, '/index.html');
  assert.equal(t.pushes.length, 1);
  // 压的是原始 href：刷新还能落回 ?view=notices&id=3 那条详情
  assert.equal(t.pushes[0].url, 'http://class.test/index.html?view=notices&id=3');
  assert.equal(t.sb.history.state.caView, 'notices');
});

test('未登录的深链被闸门改成登录页：不压记录，地址收回主页', () => {
  const t = load({ authed: false, search: '?view=todos' });
  t.sb.bootViewHistory('todos');
  // resolveView 把它改成 login，登录页没有可回退的上一页
  assert.equal(t.pushes.length, 0);
  assert.equal(t.replaces[0].url, '/index.html');
  assert.equal(t.sb.history.state.caView, 'home');
});

test('没有管理权限的 ?view=admin 深链落回主页，也不压记录', () => {
  const t = load({ canManage: false, search: '?view=admin' });
  t.sb.bootViewHistory('admin');
  assert.equal(t.pushes.length, 0);
  assert.equal(t.sb.history.state.caView, 'home');
});

test('切换视图压一条带 ?view= 的记录，重复切到同一视图不堆记录', () => {
  const t = load();
  t.sb.recordViewHistory('todos');
  assert.equal(t.pushes.length, 1);
  assert.equal(t.pushes[0].state.caView, 'todos');
  assert.equal(t.pushes[0].url, '/index.html?view=todos');
  t.sb.recordViewHistory('todos');
  t.sb.recordViewHistory('todos');
  assert.equal(t.pushes.length, 1);
});

test('登录页与「正在回退」时不写历史', () => {
  const t = load();
  t.sb.recordViewHistory('login');
  assert.equal(t.pushes.length, 0);
  // popstate 触发的切换若再压记录，后退会变成前进
  t.sb.viewHistoryNav = true;
  t.sb.recordViewHistory('notices');
  assert.equal(t.pushes.length, 0);
});

test('返回键：按记录里的视图切回去，并带上滑动方向', () => {
  const t = load({ currentView: 'todos' });
  t.sb.bootViewHistory('home');
  t.listeners.popstate.forEach((fn) => fn({ state: { caView: 'notices' } }));
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].key, 'notices');
  assert.equal(t.calls[0].dir, -1);       // notices 在 todos 左边 → 从左侧滑入
  assert.equal(t.sb.currentView, 'notices');
  // 回到当前所在视图不应再切（否则白跑一遍渲染与请求）
  t.listeners.popstate.forEach((fn) => fn({ state: { caView: 'notices' } }));
  assert.equal(t.calls.length, 1);
});

test('返回键：历史里没有状态（栈底）就回主页', () => {
  const t = load({ currentView: 'todos' });
  t.listeners.popstate.forEach((fn) => fn({ state: null }));
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].key, 'home');
});

// ===== 接线断言：上面的函数得真的接进 index.js 的启动流程 =====

test('首屏先钉历史再切视图，currentView 在初始化之前赋值', () => {
  const initAt = SRC.indexOf('// ===== 初始化');
  assert.ok(initAt > 0);
  // currentView 若留在初始化之后赋值，会把深链视图重置成 home，popstate 的
  // key===currentView 判断就会把那次回退吞掉
  assert.ok(SRC.indexOf("var currentView = 'home';") > 0
    && SRC.indexOf("var currentView = 'home';") < initAt, 'currentView 必须声明在初始化之前');

  const bootAt = SRC.indexOf('bootViewHistory(target);', initAt);
  const switchAt = SRC.indexOf('switchView(target);', initAt);
  assert.ok(bootAt > initAt, '首屏没有调用 bootViewHistory(target)');
  assert.ok(switchAt > bootAt, 'bootViewHistory 必须在 switchView 之前执行');
});

test('switchView 末尾补历史记录（且在视图真正切换之后）', () => {
  const slideAt = SRC.indexOf('slideShownView(isHome, isLogin, key, slideDir);');
  const recordAt = SRC.lastIndexOf('recordViewHistory(key);');
  assert.ok(slideAt > 0, '找不到 slideShownView 调用');
  assert.ok(recordAt > slideAt, 'switchView 末尾没有补 recordViewHistory');
  // 闸门可能把目标改写成 login/home，记录必须用改写后的 key
  assert.match(SRC.slice(slideAt, recordAt + 40), /recordViewHistory\(key\);/);
});
