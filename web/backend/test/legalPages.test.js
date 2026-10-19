/**
 * 法务页「联系方式静态可读」的静态检查。
 *
 * 站点挂在 Cloudflare 后面，Scrape Shield 的 Email Address Obfuscation 默认开启：边缘会把
 * HTML 里的邮箱替换成占位符和 /cdn-cgi/l/email-protection 链接，再由它注入的
 * email-decode.min.js 在浏览器里还原。法务页有两种还原不了的情况：
 *   1. 浏览器禁用 JavaScript，或解码脚本被扩展 / 网络拦截 —— 联系方式停在占位符，
 *      点开是 Cloudflare 的 Email Protection 页，而不是发信界面；
 *   2. 登录同意弹窗把 legal/terms.html fetch 回来再注入 DOM（见 assets/js/index.js）——
 *      解码脚本早已执行完，注入的占位符不会再有第二次解码机会，弹窗里的邮箱同样是坏的。
 * 所以三份站内法务页的邮箱必须用 Cloudflare 官方的 email_off 标记包住（边缘不再替换），
 * 保证不依赖 JS 也能读到地址、邮件链接也能直接发信。改联系方式时若漏了标记，这条用例会挡住。
 *
 * 只扫 html：legal/*.md 是源文档，不走 HTML 边缘改写。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '../..');

const PAGES = ['legal/terms.html', 'legal/privacy.html', 'legal/disclaimer.html'];

const read = (rel) => readFileSync(join(WEB, rel), 'utf8');

/** 邮箱形状：够认本站的联系方式即可，不追求 RFC 完备 */
const EMAIL_SRC = String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`;

/** Cloudflare 官方标记包住的片段 */
const OFF = /<!--email_off-->[\s\S]*?<!--\/email_off-->/g;

const emailsIn = (src) => [...src.matchAll(new RegExp(EMAIL_SRC, 'g'))].map((m) => m[0]);
const regionsIn = (src) => src.match(OFF) || [];

test('法务页里的邮箱都包在 email_off 标记内（否则 Cloudflare 会替换成占位符）', () => {
  for (const page of PAGES) {
    const src = read(page);
    const leaked = emailsIn(src.replace(OFF, ''));
    assert.deepEqual(leaked, [], `${page} 里有未包 email_off 的邮箱：${leaked.join(', ')}`);
  }
});

test('email_off 标记成对、至少包住一个邮箱（防止空标记骗过检查）', () => {
  for (const page of PAGES) {
    const src = read(page);
    const regions = regionsIn(src);
    assert.ok(regions.length > 0, `${page} 里没有 email_off 标记`);
    const opens = (src.match(/<!--email_off-->/g) || []).length;
    const closes = (src.match(/<!--\/email_off-->/g) || []).length;
    assert.equal(opens, closes, `${page} 的 email_off 标记不成对：${opens} 开 / ${closes} 关`);
    for (const region of regions) {
      assert.ok(emailsIn(region).length > 0, `${page} 有一段 email_off 标记里没有邮箱：${region}`);
    }
  }
});
