// 班级事务：通知与活动合并成「班级事务」一个导航项，并且**同一页里的两个视图**
// （原先各是一份文档、靠外壳换 iframe 切换）。这些是纯静态结构，没有可注入的运行时，
// 所以按源码断言 —— 与 viewHistory.test.js / pwa.test.js 测前端脚本的既有做法一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const exists = (p) => existsSync(new URL('../../' + p, import.meta.url));
const indexHtml = read('index.html');
const affairsHtml = read('affairs/index.html');
const indexJs = read('assets/js/index.js');
const appJs = read('assets/js/app.js');
const noticesJs = read('assets/js/notices.js');
const activitiesJs = read('assets/js/activities.js');

test('侧栏：通知与活动合并成一个「班级事务」入口', () => {
  assert.match(indexHtml, /id="navAffairs" data-view="affairs"/);
  assert.doesNotMatch(indexHtml, /id="navNotices"/);
  assert.doesNotMatch(indexHtml, /id="navActivities"/);
  assert.match(indexHtml, /我的待办/);
});

test('底栏：5 个选项卡，事务合并、待办入栏且顺序固定', () => {
  const order = [...indexHtml.matchAll(/data-nav="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['home', 'affairs', 'todos', 'academic', 'account']);
  assert.match(indexHtml, /class="bottom-nav-item" data-nav="todos" data-view="todos"/);
  assert.doesNotMatch(indexHtml, /data-nav="notices"/);
  assert.doesNotMatch(indexHtml, /data-nav="activities"/);
});

test('事务页是一份文档：两个视图 + 一套标签，活动页已并入', () => {
  assert.equal(exists('affairs/activities.html'), false, '活动页应该已经被并入 affairs/index.html');
  assert.match(affairsHtml, /<h1 class="page-title">班级事务<\/h1>/);
  assert.match(affairsHtml, /id="affairsSeg"/);
  assert.match(affairsHtml, /data-affairs-tab="notices"/);
  assert.match(affairsHtml, /data-affairs-tab="activities"/);
  // 两个视图各自一块，靠 hidden 切换；视图容器 id 固定，app.js 按它显隐
  assert.match(affairsHtml, /id="paneNotices"/);
  assert.match(affairsHtml, /id="paneActivities"[^>]*hidden/);
  assert.match(affairsHtml, /id="noticeListView"/);
  assert.match(affairsHtml, /id="activityListView"/);
  // app.js 必须先于两份页内脚本加载
  assert.ok(affairsHtml.indexOf('assets/js/app.js') < affairsHtml.indexOf('assets/js/notices.js'));
  assert.ok(affairsHtml.indexOf('assets/js/app.js') < affairsHtml.indexOf('assets/js/activities.js'));
});

test('同页共存：活动侧的弹窗与动作名带 act 前缀，不与通知侧撞 id', () => {
  // 两侧弹窗结构几乎一样，同页共用一套 id 会让两个弹窗互相写错内容
  for (const id of ['actDetailModal', 'actDetailCard', 'actEditModal', 'actEditError',
    'actEditTitle', 'actEditContent', 'actEditRemind', 'actEditSubmitBtn']) {
    assert.ok(affairsHtml.includes('id="' + id + '"'), '页面缺 ' + id);
    // 脚本里可能以 getElementById('x') 或 renderRemindBox('x', …) 的形式引用，认字符串即可
    assert.ok(activitiesJs.includes("'" + id + "'"), 'activities.js 没用上 ' + id);
  }
  assert.doesNotMatch(activitiesJs, /getElementById\('detailModal'\)/);
  // 共用动作名（关闭详情 / 取消编辑 / 加入待办）在活动侧全部加前缀，否则一次点击触发两份处理
  for (const act of ['act-close-detail', 'act-cancel-edit', 'act-add-todo-from-source']) {
    assert.ok(activitiesJs.includes('data-act="' + act + '"'), 'activities.js 缺 ' + act);
  }
});

test('外壳：通知与活动共用一个 iframe，视图名仍保留', () => {
  assert.doesNotMatch(indexHtml, /id="frameActivities"/, '活动不再有自己的 iframe');
  assert.match(indexHtml, /id="frameNotices"/);
  // 视图名 → iframe 键的别名：activities 落到 notices 那个 iframe
  assert.match(indexJs, /function frameKeyOf\(view\)/);
  assert.match(indexJs, /return view === 'activities' \? 'notices' : view;/);
  assert.match(indexJs, /fk === frameKeyOf\(key\)/);
  // 外壳把「该看哪一块」告诉页面
  assert.match(indexJs, /function notifyAffairsPane\(f, view\)/);
  assert.match(indexJs, /__caAffairsShow/);
  // affairs 别名仍落到上次看的子页（历史里记的也应是真实子页）
  assert.match(indexJs, /if \(key === 'affairs'\) key = lastAffairsTab\(\);/);
  assert.match(indexJs, /\(key === 'notices' \|\| key === 'activities'\) \? 'affairs' : key/);
});

test('深链：tab 与 id 一起拼进事务页地址', () => {
  assert.match(indexJs, /loadFrame\('notices', FRAME_URLS\.notices \+ '\?tab=' \+ target/);
  // 两份页内脚本都只在「自己那块是当前视图」时才开 ?id= 详情
  assert.match(noticesJs, /__caAffairsPane\(\) !== 'notices'/);
  assert.match(activitiesJs, /__caAffairsPane\(\) !== 'activities'/);
});

test('页内切换：不再走外壳换 iframe，也不再整页跳转', () => {
  assert.match(appJs, /function showAffairsPane\(/);
  assert.match(appJs, /function initAffairsPage\(/);
  assert.match(appJs, /window\.__caAffairsShow = function/);
  assert.doesNotMatch(appJs, /function initAffairsTabs\(/, '旧的两页切换入口应该已经删掉');
  assert.doesNotMatch(appJs, /function openAffairsTab\(/);
  assert.doesNotMatch(noticesJs, /initAffairsTabs\(/);
  assert.doesNotMatch(activitiesJs, /initAffairsTabs\(/);
  // 当前视图记在会话与 ?tab= 上：刷新、分享、外壳深链都能落回同一块
  assert.match(appJs, /sessionStorage\.setItem\(AFFAIRS_PANE_KEY, pane\)/);
  assert.match(appJs, /url\.searchParams\.set\('tab', pane\)/);
});
