/**
 * CSP 与「内联脚本 / 内联样式卫生」的静态检查。
 *
 * 为什么需要这组用例：script-src / style-src 去掉 'unsafe-inline' 之后，页面里任何内联
 * <script>、内联事件处理器（onclick 这类）或内联 style 属性都会被浏览器丢掉 —— 用户看到的是
 * 「按钮点了没反应」「样式莫名其妙没了」，而不是报错弹窗，很容易带着上线；靠手点也覆盖不全，
 * 所以直接扫源码。
 *
 * 位置说明：本仓库只有一个测试运行器（`npm test` 跑 backend/test/*.test.js），
 * 所以测前端制品（web/*.html、web/_headers、web/sw.js）的用例也放在这里，读真实文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '../..');

/** 全站的页面：每一个都受 _headers 管辖，都要能过 CSP */
const PAGES = ['index', 'notices', 'activities', 'academic', 'forms', 'account', 'admin'];

const read = (rel) => readFileSync(join(WEB, rel), 'utf8');

/**
 * 内联事件处理器属性：`on` + 事件名 + `=` + 引号。
 * 这个形状既能扫到 HTML 里的 onclick="..."，也能扫到 JS 字符串里拼出来的 'onclick="..."'。
 */
const HANDLER_SRC = String.raw`\son(click|change|input|submit|load|error|keyup|keydown|keypress|focus|blur|dblclick|contextmenu|mousedown|mouseup|mouseover|mouseout|touchstart|touchend)\s*=\s*["']`;
const handlersIn = (src) => [...src.matchAll(new RegExp(HANDLER_SRC, 'gi'))].map((m) => m[0]);

/** 没有 src 的 <script>，也就是内联脚本 */
const SCRIPT_SRC = String.raw`<script(?![^>]*\bsrc=)[^>]*>`;
const inlineScriptsIn = (src) => [...src.matchAll(new RegExp(SCRIPT_SRC, 'gi'))].map((m) => m[0]);

/** 内联样式属性：style="..."，同样连 JS 字符串里拼出来的一起扫 */
const STYLE_ATTR_SRC = String.raw`\sstyle\s*=\s*["']`;
const styleAttrsIn = (src) => [...src.matchAll(new RegExp(STYLE_ATTR_SRC, 'gi'))].map((m) => m[0]);

/** 前端脚本清单（assets/js 下的真实文件） */
const scriptFiles = () => readdirSync(join(WEB, 'assets/js')).filter((f) => f.endsWith('.js'));

test('页面与脚本里都没有内联事件处理器（CSP 下会被直接拦掉）', () => {
  const files = [
    ...PAGES.map((p) => p + '.html'),
    ...scriptFiles().map((f) => 'assets/js/' + f)
  ];
  for (const rel of files) {
    const hits = handlersIn(read(rel));
    assert.equal(hits.length, 0, `${rel} 里还有内联事件处理器：${hits.join(', ')}`);
  }
});

test('页面里没有内联 <script>（页面逻辑全部外置）', () => {
  for (const page of PAGES) {
    const hits = inlineScriptsIn(read(page + '.html'));
    assert.equal(hits.length, 0, `${page}.html 里还有内联脚本：${hits.join(', ')}`);
  }
});

test('页面与脚本里都没有内联 style 属性（CSP 下会被整条丢掉）', () => {
  // 注意是「整条丢掉」：style-src 不含 'unsafe-inline' 时，标签上的 style="…" 里
  // 的声明一条都不会生效（不是只丢某一条），表现就是「样式莫名其妙没了」。
  const files = [
    ...PAGES.map((p) => p + '.html'),
    ...scriptFiles().map((f) => 'assets/js/' + f)
  ];
  for (const rel of files) {
    const hits = styleAttrsIn(read(rel));
    assert.equal(hits.length, 0, `${rel} 里还有内联 style：${hits.join(', ')}`);
  }
});

test('页面里没有 <style> 块（样式统一在 assets/css/style.css）', () => {
  for (const page of PAGES) {
    assert.equal(/<style[\s>]/i.test(read(page + '.html')), false, `${page}.html 里有内联 <style>`);
  }
});

test('每个页面都引到了自己的外置脚本，且文件确实存在', () => {
  for (const page of PAGES) {
    const html = read(page + '.html');
    for (const rel of ['assets/js/theme.js', 'assets/js/app.js', `assets/js/${page}.js`]) {
      assert.ok(html.includes(rel), `${page}.html 没有引入 ${rel}`);
      assert.ok(existsSync(join(WEB, rel)), `${rel} 不存在`);
    }
  }
});

test('sw.js 预热清单覆盖全部前端脚本（断网打开时不能缺脚本）', () => {
  const sw = read('sw.js');
  const files = scriptFiles();
  assert.ok(files.length >= 9, `assets/js 下的脚本数量异常：${files.length}`);
  for (const f of files) {
    assert.ok(sw.includes(`'/assets/js/${f}'`), `sw.js 预热清单缺少 /assets/js/${f}`);
  }
});

test('data-act 双向对齐：页面标记的动作都有委托注册，注册的动作也都真被用到', () => {
  for (const page of PAGES) {
    // 标记可能写在 HTML 里，也可能写在 JS 拼的 innerHTML 字符串里，两边一起收
    const marked = new Set(
      [...`${read(page + '.html')}\n${read(`assets/js/${page}.js`)}`.matchAll(/data-act="([^"]*)"/g)]
        .map((m) => m[1])
    );
    const registered = new Set(
      [...read(`assets/js/${page}.js`).matchAll(/\[data-act="([^"]*)"\]/g)].map((m) => m[1])
    );
    for (const act of marked) {
      // 漏注册 = 按钮点下去没反应，且控制台不报错，最难查
      assert.ok(registered.has(act), `${page}.js 里没有 data-act="${act}" 的委托注册`);
    }
    for (const act of registered) {
      assert.ok(marked.has(act), `${page}.js 注册了 [data-act="${act}"]，但页面里没人用它`);
    }
  }
});

/** 把 _headers 里那条 CSP 解析成「指令名 → 指令全文」 */
function cspDirectives() {
  const line = read('_headers')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^Content-Security-Policy:/i.test(l));
  assert.ok(line, '_headers 里没有 Content-Security-Policy');
  const map = new Map();
  for (const part of line.replace(/^Content-Security-Policy:/i, '').split(';')) {
    const d = part.trim();
    if (d) map.set(d.split(/\s+/)[0], d);
  }
  return map;
}

test('CSP 覆盖 issue 要求的各条指令', () => {
  const d = cspDirectives();
  assert.equal(d.get('default-src'), "default-src 'self'");
  assert.equal(d.get('object-src'), "object-src 'none'");
  assert.equal(d.get('base-uri'), "base-uri 'self'");
  assert.equal(d.get('frame-ancestors'), "frame-ancestors 'self'");
  // 这几条不一定写在 issue 里，但少了就会踩坑（自家 iframe / 前端调后端 / 表单）
  assert.ok(d.has('frame-src'), '缺少 frame-src：本站页面互相 iframe 嵌套');
  assert.ok(d.has('connect-src'), '缺少 connect-src：前端要调同域后端');
  assert.ok(d.has('form-action'), '缺少 form-action');
});

test("script-src 不放行内联脚本与 eval", () => {
  const script = cspDirectives().get('script-src');
  assert.ok(script, '缺少 script-src');
  assert.ok(!/unsafe-inline/.test(script), `script-src 放开了内联脚本：${script}`);
  assert.ok(!/unsafe-eval/.test(script), `script-src 放开了 eval：${script}`);
  assert.ok(/'self'/.test(script), 'script-src 至少放行同源脚本');
});

test('第三方来源白名单逐条写死：统计两份 + 头像源一处', () => {
  // 来源写死在这里是有意的：以后想再放行一个第三方脚本/接口/图片源，必须先改这条用例 ——
  // 否则 CSP 会在「顺手加个域名」里悄悄退化成没有。
  const sources = (name) => cspDirectives().get(name).split(/\s+/).filter((s) => s !== name);
  assert.deepEqual(sources('script-src'), ["'self'", 'https://static.cloudflareinsights.com']);
  assert.deepEqual(sources('connect-src'), ["'self'", 'https://cloudflareinsights.com']);
  // weavatar.com 是绑了 QQ 邮箱后的头像源（app.js 的 qqAvatarUrl）
  assert.deepEqual(sources('img-src'), ["'self'", 'data:', 'https://weavatar.com']);
});

test("style-src 只放行 'self'（内联样式已全部外置到 style.css）", () => {
  const style = cspDirectives().get('style-src');
  assert.ok(style, '缺少 style-src');
  assert.ok(!/unsafe-inline/.test(style), `style-src 不该再放开内联样式：${style}`);
  assert.ok(/'self'/.test(style), 'style-src 至少要放行同源样式表');
});

test('点击劫持与传输层相关的头都在，且 X-Frame-Options 用 SAMEORIGIN', () => {
  const headers = read('_headers');
  // DENY 会把自家 iframe 一起挡掉（index.html 里嵌了 5 个子页），整站白屏
  assert.ok(/^\s*X-Frame-Options:\s*SAMEORIGIN\s*$/im.test(headers), 'X-Frame-Options 必须是 SAMEORIGIN');
  assert.ok(/^\s*X-Content-Type-Options:\s*nosniff\s*$/im.test(headers), '缺少 X-Content-Type-Options: nosniff');
  assert.ok(/^\s*Referrer-Policy:\s*strict-origin-when-cross-origin\s*$/im.test(headers), '缺少 Referrer-Policy');
  assert.ok(/^\s*Strict-Transport-Security:\s*max-age=\d+/im.test(headers), '缺少 HSTS');
});
