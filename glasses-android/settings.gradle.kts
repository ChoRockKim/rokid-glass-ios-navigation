pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "rokid-route-glasses"
include(":app")
// Wi-Fi 켜기 도우미 (targetSdk 28, 따로 한 번 설치)
include(":wifihelper")
