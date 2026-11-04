plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    // 화면 렌더링 테스트 (layoutlib, 에뮬레이터 없이 실제 안드로이드 그리기 코드로 PNG)
    id("app.cash.paparazzi")
}

// 서버 주소는 공개 정보라 기본값을 둔다. 토큰은 APK 에 넣지 않는다 (페어링으로 받음).
val serverBase = (project.findProperty("ROUTE_SERVER") as String?) ?: "https://route-server-production.up.railway.app"
// 안경 전용 토큰 (서버 GLASS_DEVICE_TOKEN 과 같은 값). 저장소에 넣지 않고 빌드할 때만 준다:
//   ./gradlew assembleDebug -PDEVICE_TOKEN=…   (없으면 빈 값 → 페어링으로 연결)
val deviceToken = (project.findProperty("DEVICE_TOKEN") as String?) ?: ""

android {
    namespace = "com.chorock.rokidroute"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.chorock.rokidroute"
        minSdk = 28
        targetSdk = 34
        versionCode = 7
        versionName = "0.2.4"
        buildConfigField("String", "SERVER_BASE", "\"$serverBase\"")
        buildConfigField("String", "DEVICE_TOKEN", "\"$deviceToken\"")
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
