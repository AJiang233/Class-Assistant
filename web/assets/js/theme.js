/* 主题切换：localStorage('theme') 优先，其次跟随系统 prefers-color-scheme；同步写入 <html> 的 data-theme 防闪烁。
 *
 * 独立成文件而不是内联在 <head> 里：CSP 的 script-src 只放行 'self'，
 * 内联脚本会被浏览器直接拦掉（全站样式会停在浅色且控制台报违规）。
 * 放在 <head> 里不加 defer —— 它必须在首帧绘制前跑完，否则会闪一下浅色。
 * 用 IIFE 包住，不往 window 上挂任何东西（页面里没用它，也不需要）。 */
(function () {
    var KEY = 'theme';
    var root = document.documentElement;
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    function system() { return mq.matches ? 'dark' : 'light'; }
    function stored() { try { var v = localStorage.getItem(KEY); return (v === 'dark' || v === 'light') ? v : null; } catch (e) { return null; } }
    function apply(t) { root.setAttribute('data-theme', t); }
    function current() { return stored() || system(); }
    apply(current());
    function bind() {
        if (mq.addEventListener) mq.addEventListener('change', function (e) { if (!stored()) apply(e.matches ? 'dark' : 'light'); });
        else if (mq.addListener) mq.addListener(function (e) { if (!stored()) apply(e.matches ? 'dark' : 'light'); });
        window.addEventListener('storage', function (e) { if (e.key === KEY) apply(current()); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
