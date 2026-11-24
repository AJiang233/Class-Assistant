// 底栏导航的「永远点得动」约束（对应线上 bug：从桌面小组件深链进来后停在学业页、底栏点了没反应）。
// 两条保险：①底栏项是真链接，脚本没绑上时整页跳转仍能到达目标视图；
//          ②切视图的点击委托在 index.js 最前面用捕获阶段注册，后面任何顶层语句抛错都影响不到它。
// 纯静态结构，没有可注入的运行时，按源码断言（与 affairsNav / viewHistory 的做法一致）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const indexHtml = read('index.html');
const indexJs = read('assets/js/index.js');

const VIEWS = ['home', 'affairs', 'todos', 'academic', 'account'];

test('底栏每一项都是真链接，href 与 data-view 一致且顺序正确', () => {
  const nav = indexHtml.match(/<nav class="bottom-nav" id="bottomNav">[\s\S]*?<\/nav>/);
  assert.ok(nav, '找不到底栏');
  const items = [...nav[0].matchAll(/<a class="bottom-nav-item[^"]*" data-nav="([a-z]+)" data-view="([a-z]+)" href="\?view=([a-z]+)">/g)]
    .map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(items, VIEWS.map((v) => [v, v, v]));
});

test('切视图的点击在文件最前面用捕获阶段绑定', () => {
  const capture = indexJs.match(/document\.addEventListener\('click', function \(e\) \{[\s\S]{0,900}?\}, true\);/);
  assert.ok(capture, '缺少捕获阶段的 [data-view] 点击绑定');
  assert.match(capture[0], /\[data-view\]/);
  // 必须排在后面的常规事件绑定之前——那里一旦有语句抛错，后面就全不执行了
  const bindings = indexJs.indexOf('// ===== 事件绑定 =====');
  assert.ok(bindings > 0, '找不到事件绑定段落');
  assert.ok(indexJs.indexOf(capture[0]) < bindings, '捕获绑定必须位于文件前部');
});

test('不再重复委托 [data-view]，且 iframe 循环有 null 守卫', () => {
  assert.doesNotMatch(indexJs, /delegate\(document, 'click', '\[data-view\]'/);
  assert.match(indexJs, /var f = document\.getElementById\(FRAME_KEYS\[fk\]\);\r?\n\s*\/\/[^\n]*\r?\n\s*if \(!f\) continue;/);
});
