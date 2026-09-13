/**
 * 注入到门户页面的探针脚本（对应安卓端 PROBE_JS，另增加了页面明暗主题回传）。
 *
 * 站点是「固定外壳 + 内层 .app-view 滚动」，子页面又跑在同源 iframe 里，
 * Web 组件自身拿不到真实滚动位置，因此在页面内周期性探测，经 CAHost 桥回传：
 *  - 是否允许下拉刷新（主页 + 无弹窗 + 已置顶）
 *  - localStorage 中的登录 token
 *  - 页面当前是深色还是浅色（用于状态栏图标配色）
 */
export const PROBE_JS: string = `
(function () {
  if (window.__caTopProbe) return;
  window.__caTopProbe = true;
  function atTop(doc) {
    try {
      var s = doc.scrollingElement || doc.documentElement;
      if (s && s.scrollTop > 0) return false;
    } catch (e) {}
    return true;
  }
  function onHome() {
    var h = document.getElementById('homeView');
    return !!h && h.style.display !== 'none';
  }
  function modalOpen(doc) {
    try {
      var o = doc.querySelectorAll('.modal-overlay');
      for (var i = 0; i < o.length; i++) {
        if (o[i].offsetWidth > 0 || o[i].offsetHeight > 0) return true;
      }
    } catch (e) {}
    return false;
  }
  function themeDark() {
    try {
      var el = document.documentElement;
      var bg = getComputedStyle(el).backgroundColor;
      if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
        bg = getComputedStyle(document.body).backgroundColor;
      }
      var m = bg.match(/\\d+/g);
      if (m && m.length >= 3) {
        var lum = (parseInt(m[0], 10) * 299 + parseInt(m[1], 10) * 587 + parseInt(m[2], 10) * 114) / 1000;
        return lum < 128;
      }
    } catch (e) {}
    return false;
  }
  var tick = 0;
  var lastToken = null;
  var lastDark = null;
  function probe() {
    var ok = atTop(document) && onHome() && !modalOpen(document);
    if (ok) {
      var views = document.querySelectorAll('.app-view');
      for (var v = 0; v < views.length; v++) {
        var el = views[v];
        if (!el || el.offsetParent === null) continue;
        if (el.scrollTop > 0) { ok = false; break; }
      }
    }
    if (ok) {
      var frames = document.querySelectorAll('.app-frame');
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        if (!f || f.style.display === 'none') continue;
        try {
          if (f.contentDocument && !atTop(f.contentDocument)) { ok = false; break; }
        } catch (e) {}
      }
    }
    try { CAHost.setPullRefreshReady(ok); } catch (e) {}
    if (++tick % 8 === 0) {
      reportToken();
      reportTheme();
    }
  }
  function looksLikeJwt(v) {
    return typeof v === 'string' && v.length > 40 && v.split('.').length === 3;
  }
  function readToken() {
    try {
      var known = ['ca_token', 'token', 'jwt', 'auth_token'];
      for (var k = 0; k < known.length; k++) {
        var kv = localStorage.getItem(known[k]);
        if (kv && looksLikeJwt(kv)) return kv;
      }
      var keys = Object.keys(localStorage);
      for (var i = 0; i < keys.length; i++) {
        var v = localStorage.getItem(keys[i]);
        if (v && looksLikeJwt(v)) return v;
      }
    } catch (e) {}
    return '';
  }
  function reportToken() {
    var t = readToken();
    if (t === lastToken) return;
    lastToken = t;
    try { CAHost.setToken(t); } catch (e) {}
  }
  function reportTheme() {
    var d = themeDark();
    if (d === lastDark) return;
    lastDark = d;
    try { CAHost.setTheme(d); } catch (e) {}
  }
  setInterval(probe, 250);
  probe();
  reportToken();
  reportTheme();
})();
`;
