/**
 * 「个人中心 → 关于软件 → 检查更新」读的 version.json，以及它的路径写法。
 *
 * 为什么单独钉这两个点：
 *   1) 个人页是嵌在 #frameAccount 里的独立文档，文档地址是 /account/。检查更新曾经写成
 *      相对路径 `fetch('version.json?…')`，于是请求变成 /account/version.json ——
 *      Pages 的单页回退对不存在的路径也回 200 HTML，res.ok 为真、res.json() 抛错，
 *      用户看到的永远是「检查更新失败」，且跟网络/代理完全无关（1.4.6 线上反馈）。
 *   2) version.json 的 url 必须是 GitHub 的稳定直链。Release 页面上
 *      release-assets.githubusercontent.com 那种带签名的临时地址几十分钟就过期，
 *      写进去的话「发现新版本 → 前往下载」会在一段时间后变成 404。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCOUNT_JS = readFileSync(join(HERE, '../../assets/js/account/about.js'), 'utf8');
const VERSION_JSON = JSON.parse(readFileSync(join(HERE, '../../version.json'), 'utf8'));

test('检查更新读站点根目录的 /version.json，不用相对路径', () => {
    assert.match(
        ACCOUNT_JS,
        /fetch\('\/version\.json\?_='/,
        '检查更新必须用绝对路径 /version.json：个人页文档在 /account/，相对路径会落到 /account/version.json'
    );
    assert.doesNotMatch(
        ACCOUNT_JS,
        /fetch\('version\.json\?_='/,
        '相对路径 fetch(\'version.json\') 在 /account/ 下会被 SPA 回退成 HTML，永远提示检查更新失败'
    );
});

test('version.json 每段都带 version 与 url（缺一个页面就只会提示检查失败）', () => {
    const sections = Object.entries(VERSION_JSON).filter(([key]) => !key.startsWith('note'));
    assert.ok(sections.length > 0, 'version.json 里没有任何平台段');
    for (const [platform, section] of sections) {
        assert.equal(typeof section.version, 'string', `${platform}.version 必须是字符串`);
        assert.ok(section.version.trim(), `${platform}.version 不能为空`);
        assert.equal(typeof section.url, 'string', `${platform}.url 必须是字符串`);
        assert.ok(section.url.trim(), `${platform}.url 不能为空`);
    }
});

test('version.json 的下载地址是 GitHub 稳定直链，不是会过期的签名地址', () => {
    for (const [platform, section] of Object.entries(VERSION_JSON)) {
        if (platform.startsWith('note')) continue;
        const url = section.url.trim();
        assert.doesNotMatch(
            url,
            /release-assets\.githubusercontent\.com/,
            `${platform}.url 不能用 release-assets 的临时签名地址（几十分钟就过期）`
        );

        // 走 releases/download 的段：tag 与文件名都要和 version 对得上，
        // 否则「前往下载」会指向一个不存在的附件（发版时改漏一处就会这样）。
        const m = /^https:\/\/github\.com\/AJiang233\/Class-Assistant\/releases\/download\/v([^/]+)\/(.+)$/.exec(url);
        if (!m) continue;
        assert.equal(m[1], section.version.trim(), `${platform}.url 的 tag 必须等于 version`);
        assert.ok(
            m[2].includes(section.version.trim()),
            `${platform}.url 的文件名里必须带上 version（${m[2]} 不含 ${section.version}）`
        );
    }
});
