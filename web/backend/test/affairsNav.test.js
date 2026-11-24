// issue #95：班级通知 + 班级活动合并为「班级事务」，页内用子标签切换；同时把「我的待办」
// 放进移动端底栏。这些是纯静态结构，没有可注入的运行时，所以按源码断言 —— 与
// viewHistory.test.js / pwa.test.js 测前端脚本的既有做法一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const indexHtml = read('index.html');
const noticesHtml = read('notices.html');
const activitiesHtml = read('activities.html');
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

test('事务页：统一页头 + 通知/活动子标签', () => {
  for (const html of [noticesHtml, activitiesHtml]) {
    assert.match(html, /<h1 class="page-title">班级事务<\/h1>/);
    assert.match(html, /id="affairsSeg"/);
    assert.match(html, /id="affairsSegPill"/);
    assert.match(html, /data-affairs-tab="notices"/);
    assert.match(html, /data-affairs-tab="activities"/);
  }
  // app.js 必须先于页内脚本加载，initAffairsTabs / openAffairsTab 才可用
  assert.ok(noticesHtml.indexOf('assets/js/app.js') < noticesHtml.indexOf('assets/js/notices.js'));
  assert.ok(activitiesHtml.indexOf('assets/js/app.js') < activitiesHtml.indexOf('assets/js/activities.js'));
});

test('外壳：affairs 别名落到上次看的子页，两个子页一起预载', () => {
  assert.match(indexJs, /if \(key === 'affairs'\) key = lastAffairsTab\(\);/);
  assert.match(indexJs, /\(key === 'notices' \|\| key === 'activities'\) \? 'affairs' : key/);
  assert.match(indexJs, /'notices', 'affairs'/, '深链白名单要接受 affairs');
  assert.match(indexJs, /\[AFFAIRS_TAB_KEY, key\]|sessionStorage\.setItem\(AFFAIRS_TAB_KEY, key\)/);
  assert.match(indexJs, /\['notices', 'activities'\]\.forEach/, '进入事务页时两页一起预载');
});

test('子标签点击：外壳内换 iframe，外壳外整页跳转', () => {
  assert.match(appJs, /function initAffairsTabs\(/);
  assert.match(appJs, /window\.top\.switchView\(target\)/);
  assert.match(appJs, /index\.html\?view='/);
  assert.match(noticesJs, /initAffairsTabs\('notices'\)/);
  assert.match(activitiesJs, /initAffairsTabs\('activities'\)/);
});
