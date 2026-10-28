param([switch]$DebugOnly)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $readerNodeCommand = Get-Command node -ErrorAction Stop
    $readerNpmCommand = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $env:JAVA_HOME) {
        $readerJavaSetting = Select-String -LiteralPath 'gradle.properties' -Pattern '^\s*org\.gradle\.java\.home\s*=\s*(.+)$' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($readerJavaSetting) { $env:JAVA_HOME = $readerJavaSetting.Matches[0].Groups[1].Value.Trim() }
    }
    if (-not $env:JAVA_HOME -or -not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin/java.exe'))) {
        throw '请设置 JAVA_HOME 为 JDK 17 或更新版本，或在 gradle.properties 中配置 org.gradle.java.home。'
    }
    if (-not (Test-Path -LiteralPath 'local.properties')) {
        $readerSdkPath = $env:ANDROID_HOME
        if (-not $readerSdkPath) { $readerSdkPath = $env:ANDROID_SDK_ROOT }
        if (-not $readerSdkPath -and (Test-Path -LiteralPath 'F:\MoyueReaderTools\sdk')) { $readerSdkPath = 'F:\MoyueReaderTools\sdk' }
        if (-not $readerSdkPath) { throw '请设置 ANDROID_HOME，或在 local.properties 中配置 sdk.dir。' }
        $readerEscapedSdk = $readerSdkPath.Replace('\','/').Replace(':','\:')
        $readerEscapedSdk = [regex]::Replace($readerEscapedSdk, '[^\u0000-\u007F]', { param($readerCharMatch) '\u' + ([int][char]$readerCharMatch.Value).ToString('x4') })
        Set-Content -LiteralPath 'local.properties' -Value "sdk.dir=$readerEscapedSdk" -Encoding ascii
    }
    if (-not (Test-Path -LiteralPath 'node_modules/esbuild')) {
        if ($readerNpmCommand) { & $readerNpmCommand.Source ci --no-fund --no-audit }
        else {
            $readerNpmCli = Join-Path (Split-Path -Parent $readerNodeCommand.Source) 'node_modules/npm/bin/npm-cli.js'
            if (Test-Path -LiteralPath $readerNpmCli) { & $readerNodeCommand.Source $readerNpmCli ci --no-fund --no-audit }
            else { throw '未找到 npm，请安装 Node.js LTS（含 npm）。' }
        }
        if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
    }
    & $readerNodeCommand.Source scripts/build-web.mjs
    if ($LASTEXITCODE -ne 0) { throw '阅读界面构建失败。' }
    $readerTestFiles = Get-ChildItem -LiteralPath 'tests' -Filter '*.test.mjs' | ForEach-Object { $_.FullName }
    & $readerNodeCommand.Source --test @readerTestFiles
    if ($LASTEXITCODE -ne 0) { throw '格式测试失败。' }
    if (-not $DebugOnly) {
        if (-not (Test-Path -LiteralPath '.signing/moyue-release.jks')) {
            if (Test-Path -LiteralPath '.signing/signing.properties') { throw '签名密钥缺失，请恢复原有 .signing 目录，避免生成不兼容的更新包。' }
            New-Item -ItemType Directory -Path '.signing' -Force | Out-Null
            $readerKeyPassword = [guid]::NewGuid().ToString('N')
            & (Join-Path $env:JAVA_HOME 'bin/keytool.exe') -genkeypair -keystore '.signing/moyue-release.jks' -storepass $readerKeyPassword -keypass $readerKeyPassword -alias moyue -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Moyue Reader, OU=Reader, O=Moyue, L=Shanghai, C=CN'
            if ($LASTEXITCODE -ne 0) { throw '签名密钥生成失败。' }
            Set-Content -LiteralPath '.signing/signing.properties' -Value "storePassword=$readerKeyPassword`nkeyAlias=moyue`nkeyPassword=$readerKeyPassword" -Encoding ascii
        }
        & '.\gradlew.bat' --no-daemon :app:assembleRelease :app:lintRelease --console=plain
    } else { & '.\gradlew.bat' --no-daemon :app:assembleDebug --console=plain }
    if ($LASTEXITCODE -ne 0) { throw 'Android 构建失败。' }
    New-Item -ItemType Directory -Path 'release' -Force | Out-Null
    if ($DebugOnly) { Copy-Item -LiteralPath 'app/build/outputs/apk/debug/app-debug.apk' -Destination 'release/墨阅-1.0.0-debug.apk' }
    else {
        Copy-Item -LiteralPath 'app/build/outputs/apk/release/app-release.apk' -Destination 'release/墨阅-1.0.0.apk'
        $readerHash = Get-FileHash -LiteralPath 'release/墨阅-1.0.0.apk' -Algorithm SHA256
        Set-Content -LiteralPath 'release/SHA256.txt' -Value ($readerHash.Hash.ToLowerInvariant() + '  墨阅-1.0.0.apk') -Encoding utf8
    }
    Write-Output '构建完成，安装包位于 release 目录。'
} finally { Pop-Location }
