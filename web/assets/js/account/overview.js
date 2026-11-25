(function () {
// 个人中心 · 总览
// 资料摘要卡由 core.js 渲染；本页只负责入口卡上的「进入管理员面板」。
delegate(document, 'click', '[data-act="open-admin"]', function () { window.caOpenAdmin(); });
})();
