# release 的 R8 规则（开关见 build.gradle.kts 的 release buildType）。
#
# 这里只有一条规则，其余不用管：清单里注册的组件（Activity / Service / 两个小组件 /
# 各接收器）由 AGP 按清单自动补规则，ViewBinding 生成的类、WorkManager 的 Worker
# 也都由各自的 consumer 规则兜住。

# ── WebView 的 JS 桥（跨语言契约）──
# HostBridge 的方法名同时写在两侧：原生侧 MainActivity.PROBE_JS（CAHost.setToken /
# CAHost.setPullRefreshReady）与网页侧的十来个调用点（登录态同步、下拉刷新探针、后台状态
# 卡片、课程提醒设置、推送测试…）。名字一旦被改名就是**静默失效**：页面那边每处调用都包在
# try/catch 里（纯网页版没有桥也得能跑），"方法不存在" 被一起吞掉 —— 不崩、不报错、无日志，
# 只在现场表现成「登录态没同步过来」「个人页那几张卡片是空的」这类没人会往混淆上想的现象。
#
# 这条与 AGP 默认规则里那条通配版（保留带 @JavascriptInterface 的方法，见
# app/build/outputs/mapping/release/configuration.txt 的 "Preserve annotated Javascript
# interface methods"）**等效**，写出来不是为了补漏，而是把这份契约摆到源码里：
# 以后真出问题（桥调不到）时，不必在「默认规则会不会变、重构后还覆不覆盖」上猜。
# 只保方法名、不保类名：类名混淆动不了它 —— 页面里那个 "CAHost" 是字符串常量。
-keepclassmembers class com.classassistant.app.MainActivity$HostBridge {
    @android.webkit.JavascriptInterface <methods>;
}
