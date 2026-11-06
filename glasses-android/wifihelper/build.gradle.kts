// "길안내 Wi-Fi 도우미" (rokid-conversate 의 wifihelper 를 그대로 가져옴): 본앱 대신 Wi-Fi 를 켠다.
// 안드로이드는 targetSdk 28 이하 앱에만 WifiManager.setWifiEnabled 를 허용한다 (그 위는 조용히 false).
// 본앱은 확인 없는 OTA 때문에 28로 낮출 수 없어서, 이 작은 앱을 한 번만 따로 설치한다. 화면 없음.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseKeystore = project.findProperty("RELEASE_KEYSTORE") as String?
val releaseKeystorePass = project.findProperty("RELEASE_KEYSTORE_PASS") as String?

android {
    namespace = "com.chorock.rokidroute.wifihelper"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.chorock.rokidroute.wifihelper"
        minSdk = 26
        @Suppress("ExpiredTargetSdkVersion")
        targetSdk = 28 // 일부러 (위 설명)
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        if (releaseKeystore != null && releaseKeystorePass != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = releaseKeystorePass
                keyAlias = "rokidroute"
                keyPassword = releaseKeystorePass
            }
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint {
        checkReleaseBuilds = false
        disable += "ExpiredTargetSdkVersion"
    }
}
