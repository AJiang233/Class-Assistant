/**
 * 中国大学MOOC 账号卡的前端契约（读真实源码钉形状）。
 *
 * 背景：服务端把 STUDY_INFO 里的网易内部别名（yd.<hash>@163.com）当展示名，用户绑完以为
 * 「登上了别人的号」；绑定又不落课程缓存，账号卡显示「课程数 0 门」，看起来像没识别到课程。
 * 服务端已修（/status 回 courses、身份纠正），这里钉住前端必须把这些信息真的渲染出来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCOUNT = readFileSync(join(HERE, '../../assets/js/account.js'), 'utf8');
const STYLE = readFileSync(join(HERE, '../../assets/css/style.css'), 'utf8');

/** 取一个函数体：从 `function name(` 到下一个顶层 `function ` 之间 */
function functionBody(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, '找不到函数 ' + name);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test('MOOC 账号卡渲染学号与真实姓名，而不是内部别名', () => {
  const body = functionBody(ACCOUNT, 'renderMoocBinding');
  assert.match(body, /data\.realName/, '展示名必须优先用 realName');
  assert.match(body, /学号 /, '纯数字账号要标成「学号」');
  assert.match(body, /@163\\\.com/i, '内部别名要能被识别出来并给提示');
  assert.match(body, /bind-courses/, '要渲染已读取课程列表');
  assert.match(body, /data\.courses/, '课程列表来自 /api/mooc/status 的 courses');
  assert.match(body, /bind-course-meta/, '课程后要带 已学/总节数');
});

test('绑定成功提示优先显示姓名（App 内登录用户没看清小窗时能确认账号）', () => {
  const body = functionBody(ACCOUNT, 'bindMoocWithCookies');
  assert.match(body, /bound\.realName \|\| bound\.account/, '提示不能只回显内部别名');
});

test('课程列表样式存在（否则渲染出来是裸列表）', () => {
  assert.match(STYLE, /\.bind-course-list\s*\{/, '缺少 .bind-course-list 样式');
  assert.match(STYLE, /\.bind-course-meta\s*\{/, '缺少 .bind-course-meta 样式');
});
