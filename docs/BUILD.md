# 构建、部署与发布

## 环境

| 工具 | 要求 |
| --- | --- |
| Node.js | 22+，含 npm，依赖以 package-lock.json 为准 |
| Java | JDK 17，设置 JAVA_HOME |
| Android | SDK Platform 35、Build Tools 34.0.0，设置 ANDROID_HOME |
| Gradle | Wrapper 8.9；Android Gradle Plugin 8.7.3 |

用 Android Studio SDK Manager 安装对应 SDK，或运行 `sdkmanager "platforms;android-35" "build-tools;34.0.0" "platform-tools"` 并自行阅读、接受所需许可。

也可在不提交的 local.properties 设置 `sdk.dir=/absolute/path/to/android-sdk`。Windows 路径推荐正斜杠，如 `sdk.dir=C:/Android/Sdk`。不要提交机器路径或更改 Wrapper 校验值。

## 调试包

```sh
npm ci
npm run build:web
npm test
```

Windows：`./build-apk.ps1 -DebugOnly`。脚本会构建 Web 资源、运行测试及 Android 构建，复制到 `release/墨阅-1.0.0-debug.apk`。

Linux / macOS：

```sh
chmod +x gradlew
./gradlew --no-daemon :app:assembleDebug :app:lintDebug
```

产物为 app/build/outputs/apk/debug/app-debug.apk。在 Android Studio 中构建也必须先运行 Web 构建，否则 APK 缺少阅读页面。

## 正式签名

原正式发布密钥不在开源仓库中。Fork 应使用自己的签名；不同签名无法覆盖原应用。请先备份数据，或修改 app/build.gradle 的 applicationId 并行安装。

Windows 首次运行 `./build-apk.ps1` 会在本地 .signing/ 创建自己的 RSA 密钥和随机密码配置，再执行 release 构建及 lint。必须备份整个 .signing/，以后更新使用同一密钥。已有密码配置但缺少密钥时脚本会停止。

其他系统可用 JDK keytool 交互创建 .signing/moyue-release.jks，别名 moyue，再创建本地 .signing/signing.properties：

```properties
storePassword=YOUR_LOCAL_STORE_PASSWORD
keyAlias=moyue
keyPassword=YOUR_LOCAL_KEY_PASSWORD
```

不要提交或公开此配置、JKS、密码或私钥。完成后运行：

```sh
npm run build:web
npm test
./gradlew --no-daemon :app:assembleRelease :app:lintRelease
```

产物为 app/build/outputs/apk/release/app-release.apk。Windows 脚本沿用历史下载位置，复制为 release/墨阅-1.0.0.apk；实际版本以包内 versionName 为准，当前 1.2.0。

## 网页预览与测试

```sh
npm run build:web
npx playwright install chromium
npm run dev
```

打开 http://127.0.0.1:4173；另一个终端运行 `npm run test:ui`、`node tests/reader-v120.mjs`。这是本地 QA 预览，文件选择、系统 PDF、亮度、返回键等原生能力仍需 APK 验证。

部分 tests/android-*.mjs 和历史 release 回归脚本使用固定 SDK 路径、模拟器名称及旧版基线，不能直接作为通用真机测试命令。应先审阅、适配，并在可清空数据的专用模拟器运行。

## GitHub Actions

Android CI 执行依赖安装、Web 构建、全部单元测试、1.2.0 浏览器回归、assembleDebug 和 lintDebug，再上传调试 APK artifact。它不使用正式密钥，也不自动发布正式安装包；artifact 有保留期限。

## 正式发布

1. 同时更新 package.json、锁文件与 app/build.gradle 版本，递增 versionCode，更新 CHANGELOG。
2. 用原正式密钥构建，完成测试及旧版覆盖安装、启动、导入、阅读、备份恢复验证。
3. 用 apksigner verify --verbose --print-certs 验证签名，以 sha256sum 或 Get-FileHash -Algorithm SHA256 计算摘要。
4. 创建 GitHub Release，上传 APK、SHA256.txt 与更新说明。不提交密钥、用户书籍、个人数据和构建目录。

无需部署服务器、数据库、域名或 API 密钥。安装 APK 到兼容 Android 设备即可。
