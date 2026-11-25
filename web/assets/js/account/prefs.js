(function () {
// 个人中心 · 外观与偏好
// 内容：主题外观（跟随系统 / 浅色 / 深色）。
// ===== 偏好设置：主题外观 =====
function currentThemeChoice() {
    try { var v = localStorage.getItem('theme'); return (v === 'dark' || v === 'light') ? v : 'system'; } catch (e) { return 'system'; }
}
function applyTheme(choice) {
    var resolved = choice === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : choice;
    document.documentElement.setAttribute('data-theme', resolved);
    try {
        if (choice === 'system') localStorage.removeItem('theme');
        else localStorage.setItem('theme', choice);
    } catch (e) {}
    // 同步到应用壳（父窗口），保持一致
    try {
        if (window.parent && window.parent !== window && window.parent.document) {
            window.parent.document.documentElement.setAttribute('data-theme', resolved);
        }
    } catch (e) {}
}
function markThemeSeg() {
    var seg = document.getElementById('themeSeg');
    if (!seg) return;
    var cur = currentThemeChoice();
    var btns = seg.querySelectorAll('.tab');
    for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].getAttribute('data-theme-choice') === cur);
    }
    moveThemeSegPill();
}
// 滑动滑块：与移动端底栏同款，位置与尺寸按激活项实测写入
function moveThemeSegPill() {
    var pill = document.getElementById('themeSegPill');
    if (!pill) return;
    var active = pill.parentNode.querySelector('.tab.active');
    if (!active) { pill.style.opacity = '0'; return; }
    pill.style.left = active.offsetLeft + 'px';
    pill.style.top = active.offsetTop + 'px';
    pill.style.width = active.offsetWidth + 'px';
    pill.style.height = active.offsetHeight + 'px';
    pill.style.opacity = '1';
}
(function bindThemeSeg() {
    var seg = document.getElementById('themeSeg');
    if (!seg) return;
    seg.addEventListener('click', function (e) {
        var btn = e.target;
        while (btn && btn !== seg && !btn.getAttribute('data-theme-choice')) btn = btn.parentNode;
        if (!btn || btn === seg) return;
        applyTheme(btn.getAttribute('data-theme-choice'));
        markThemeSeg();
    });
    window.addEventListener('storage', function (e) { if (e.key === 'theme') markThemeSeg(); });
    markThemeSeg();
    // 首帧布局稳定后再定位一次；旋屏/尺寸变化时重算
    setTimeout(moveThemeSegPill, 0);
    window.addEventListener('resize', moveThemeSegPill);
    // 这一页是预载的，初始化时还在 display:none 里，滑块的宽度量不到；
    // 外壳把个人中心显示出来时会通知一次（见 app.js 的 onFrameShown）。
    onFrameShown(moveThemeSegPill);
})();
// 本页只有一张可折叠卡（外观），折叠逻辑在 app.js 的 toggleCollapse
})();
