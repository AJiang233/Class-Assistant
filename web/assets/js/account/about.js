(function () {
// 个人中心 · 关于与支持
// 内容：版本号与检查更新（安装入口、问题反馈的按钮在 app.js 里）。
// ===== 关于软件：版本号 + 检查更新 =====
// App 内取原生版本号（安卓回传 BuildConfig.VERSION_NAME，鸿蒙回传 app.json5 的 versionName）；
// 网页版没有桥，显示「网页版」
var appVersion = '';
(function loadAppVersion() {
    try {
        if (window.CAHost && typeof CAHost.appVersion === 'function') appVersion = CAHost.appVersion() || '';
    } catch (e) {}
    var el = document.getElementById('aboutVersion');
    if (el) el.textContent = appVersion ? 'v' + appVersion : '网页版';
})();

/** 逐段按数字比较：0.10.0 > 0.9.0，直接比字符串会判反 */
function isNewer(latest, current) {
    var a = String(latest).split('.'), b = String(current).split('.');
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
        var x = parseInt(a[i], 10) || 0, y = parseInt(b[i], 10) || 0;
        if (x !== y) return x > y;
    }
    return false;
}

/**
 * 自己是什么端，就只读 version.json 里哪一段。
 * 没有原生桥（纯网页版）返回空串 —— 那就不读任何一段，网页自己不需要更新。
 */
function platformKey() {
    try {
        if (window.CAHost && typeof CAHost.platform === 'function') {
            var p = String(CAHost.platform() || '').trim();
            // 只认 version.json 里真有的段。将来真发 iOS 版时要在这里补回 'ios'，
            // 否则 iOS 壳内会落进「没桥」那一支，提示「当前是网页版，网页不需要更新」。
            if (p === 'android' || p === 'harmony') return p;
        }
    } catch (e) {}
    return '';
}

// 「最新版本」写在站点根目录的 version.json，按端分段（发版时改对应那段，
// 与该端安装包的版本号保持一致）；带时间戳 + no-store 是绕开 Cloudflare 与
// Service Worker 的缓存，否则检查更新永远看到旧值。
//
// 路径必须写成绝对 `/version.json`：个人页跑在 #frameAccount 这个 iframe 里，
// 文档地址是 /account/，相对路径会被解析成 /account/version.json —— Pages 的
// SPA 回退对不存在的路径也回 200 HTML，res.json() 于是抛错，页面一直显示
// 「检查更新失败」（1.4.6 用户反馈的就是这个）。
async function checkUpdate() {
    var btn = document.getElementById('updateBtn');
    var hint = document.getElementById('updateHint');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '检查中…';
    hint.textContent = '';
    try {
        var res = await fetch('/version.json?_=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = (await res.json()) || {};
        var key = platformKey();
        var section = key ? (data[key] || {}) : {};
        var latest = String(section.version || '').trim();
        // 只认自己那段里写的 url：没桥（纯网页版）或缺 version / url 都算失败，
        // 不猜地址、也不退回 Actions 构建产物页 —— 那页不是版本下载入口
        var link = String(section.url || '').trim();
        if (!key) {
            hint.textContent = '当前是网页版，网页不需要更新。';
        } else if (!latest || !link) {
            hint.textContent = '检查更新失败';
        } else if (isNewer(latest, appVersion)) {
            hint.innerHTML = '发现新版本：v' + esc(latest) + '，<a href="' + escAttr(safeHref(link)) + '" target="_blank" rel="noopener">前往下载</a>';
        } else {
            hint.textContent = '已是最新版本：v' + appVersion;
        }
    } catch (e) {
        hint.textContent = '检查更新失败';
    }
    btn.disabled = false;
    btn.textContent = label;
}

// ===== 事件绑定（本页）=====
delegate(document, 'click', '[data-act="install-app"]', function () { installApp(); });
delegate(document, 'click', '[data-act="check-update"]', function () { checkUpdate(); });
})();
