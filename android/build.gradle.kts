// 顶层构建文件
plugins {
    // AGP 8.6.1：这是能编译 compileSdk 35 的最低一档（Android 15 的 SDK 要求 AGP ≥ 8.6.1），
    // 而 AGP 8.6 又要求 Gradle ≥ 8.7 —— 两者是绑在一起的，动一个就得动另一个（见 wrapper）。
    // Kotlin 1.9.22 这次**没有跟着升**：KGP 这一档官方测过的 Gradle 上限比 8.7 老，
    // 上来可能提示一句「未测试过的组合」（只是警告，不是失败）。真出问题再把它一起提。
    id("com.android.application") version "8.6.1" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
}
