plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.classassistant.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.classassistant.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    // 正式签名：CI 从 Secrets 还原出 keystore，再用环境变量把路径与口令传进来。
    // 缺环境变量时不创建这个配置，release 会产出未签名的 app-release-unsigned.apk
    // （能编译、装不上）——既不影响 assembleDebug，也杜绝「本地没密钥却拿 debug 密钥签个包发出去」
    val keystorePath = System.getenv("CA_KEYSTORE_FILE")
    if (keystorePath != null) {
        signingConfigs {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("CA_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("CA_KEY_ALIAS")
                keyPassword = System.getenv("CA_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // R8：压缩 + 混淆。收益是体积、方法数，以及最基础的反编译门槛（现在是能直接
            // 反出可读的 Kotlin 代码）。风险点是**跨语言契约**：网页是按字面量调 CAHost 上的
            // 方法的，方法名被改名不会报错、只会静默失效，所以 keep 规则写在 proguard-rules.pro 里。
            isMinifyEnabled = true
            // 资源收缩，必须与上面的代码收缩一起开：它靠的就是 R8 结果里「哪些资源还被引用」
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // 这里以前挂的是 debug 签名配置：CI 的 runner 是干净环境，没有 ~/.android/debug.keystore，
            // AGP 每次现生成一把随机密钥，于是每个包的签名都不同，装机必须先卸载。
            // 改成固定 keystore 后（缺 Secrets 时为 null → 出未签名包）签名才稳定、能覆盖升级。
            // 注意换签名这一次仍要重装：旧包是随机 debug 密钥签的，那把密钥随 runner 一起没了。
            signingConfig = signingConfigs.findByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        viewBinding = true
        // 个人页「关于软件」要显示 App 版本号，读 BuildConfig.VERSION_NAME；
        // AGP 8 起 buildConfig 默认关闭，不显式打开就没有这个类
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.work:work-runtime-ktx:2.9.0")
    implementation("com.google.android.material:material:1.11.0")

    // 课表的日期逻辑（第几周 / 下一个有课的日子 / 闹钟编号）是纯函数，直接用 JVM 单测钉住：
    // 这类代码算错了不会崩，只会悄悄显示错的那一天。
    // 命令：./gradlew testDebugUnitTest
    testImplementation("junit:junit:4.13.2")
}
