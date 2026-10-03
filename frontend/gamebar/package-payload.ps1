# 把 Game Bar 小组件做成「启动器安装包能直接带的那几样东西」：
#   widget.msix                 签好名的包（没签名 Windows 不装）
#   widget.cer                  它的签名证书（安装时进当前用户的「受信任人」）
#   deps\*.appx                 三个框架依赖，目标机通常没有，必须随包带
#   INSTALL.txt / widget-payload.json   手动补救用的说明与校验信息
#
# 为什么签名证书是每次现打：私钥不能进 git；要固定下来得走 GitHub secret 导入 PFX，
# 那是后一步。现打也能用 —— 安装脚本会先卸旧的包再装新的（换证书签的同 identity 包
# 不能被覆盖安装），并且会顺手清掉同主题的旧证书。
#
# 产物直接写进启动器的 resources 目录（CI 里是 src-tauri/payload/gamebar）：
# 那几个路径在 tauri.conf.json 的 bundle.resources 里，仓库里另有 0 字节占位兜底
# （src-tauri/build.rs），所以这一步失败也不会把发版流程卡住 —— 只是那个安装包不带小组件。
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Debug',
    [Parameter(Mandatory = $true)][string]$OutDir,
    [string]$TimestampUrl
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This script requires Windows and Visual Studio UWP build tools.' }

# 分步日志：CI 上跑的时候拿不到实时输出（作业没结束就看不到日志），所以每步开头打一行
# 带时间的进度。万一某一步挂住，日志最后一行就是卡住的动作。
function Write-Step([string]$Text) {
    Write-Host ("==> {0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $Text)
}

$root = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $root '..\..')).Path
$out = $OutDir
if (-not [System.IO.Path]::IsPathRooted($out)) { $out = Join-Path (Get-Location).Path $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null
$depsOut = Join-Path $out 'deps'
New-Item -ItemType Directory -Force -Path $depsOut | Out-Null

# 包名/发布者必须对得上：证书 Subject 和清单 Publisher 不一致时 signtool 直接报错。
Write-Step '1/6 读小组件清单，核对包名/发布者/版本'
$manifestPath = Join-Path $root 'Widget\Package.appxmanifest'
[xml]$manifest = Get-Content $manifestPath -Raw -Encoding UTF8
$publisher = [string]$manifest.Package.Identity.Publisher
$widgetVersion = [string]$manifest.Package.Identity.Version
if ($publisher -ne 'CN=FantasyHub') { throw "Unexpected manifest Publisher: $publisher" }

# 启动器版本（根 Cargo.toml 与 package.json 的 5 处之一）和小组件版本对不上只是"显示旧版本"，
# 不影响安装（安装脚本按包 hash 判断要不要重装），所以只提醒、不拦。
$launcherVersion = ((Get-Content (Join-Path $repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version)
if ($widgetVersion -ne "$launcherVersion.0") {
    Write-Warning "Widget manifest version $widgetVersion != launcher $launcherVersion.0 — bump frontend/gamebar/Widget/Package.appxmanifest too (see .clinerules 版本 6 处)."
}

# 自签证书：Code Signing EKU 是 AppX 签名的最低要求。
Write-Step '2/6 New-SelfSignedCertificate'
$cert = New-SelfSignedCertificate -Type Custom -Subject $publisher -FriendlyName 'FantasyHub Game Bar widget (CI)' `
    -CertStoreLocation 'Cert:\CurrentUser\My' -KeyUsage DigitalSignature -KeyExportPolicy Exportable `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
$cerPath = Join-Path $out 'widget.cer'
Write-Step '3/6 导出 widget.cer'
# 用 .NET 的 Export 直接写文件：**这一步刻意完全不碰证书存储**。
# 为什么：想让自签根被信任，唯一办法是把它写进 Root 存储，而 Windows 在那条路径上会弹
# 「安全警告」等用户点确认 —— CI 上没人点，脚本就永久挂住（第一次跑 CI 实测卡了十几分钟，
# 只能人工取消）。`Import-Certificate` 和 `X509Store.Add` 底层是同一个 API，换写法换不掉弹框，
# 所以 CI 干脆不建立信任：链验证也一并跳过（-SkipVerify），签名到底有没有效，
# 由目标机安装时 AppxDeployment 的校验说话。
$cerPath = Join-Path $out 'widget.cer'
[System.IO.File]::WriteAllBytes($cerPath, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))

# -TimestampUrl 只在给了值时才传：给 [string] 参数传 $null 在多平台上行为不一致，别赌。
# -SkipVerify：理由同上 —— 自签根的信任在无人值守环境里建不起来，verify 必然失败。
Write-Step '4/6 build-windows.ps1（编译 → 签名）'
$buildArgs = @{ Configuration = $Configuration; CertificateThumbprint = $cert.Thumbprint; SkipVerify = $true }
if ($TimestampUrl) { $buildArgs.TimestampUrl = $TimestampUrl }
try {
    & (Join-Path $root 'build-windows.ps1') @buildArgs
} catch {
    throw "build-windows.ps1 failed: $($_.Exception.Message)"
}

Write-Step '5/6 读 build-result.json（确认这次真的签了名）'
$resultJson = @(Get-ChildItem (Join-Path $root 'AppPackages') -Recurse -Filter 'build-result.json' -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1)
if ($resultJson.Count -eq 0) { throw 'build-windows.ps1 produced no build-result.json.' }
$result = Get-Content $resultJson[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $result.signed) { throw 'The widget package came out unsigned; refusing to ship it.' }
if (-not $result.chainVerified) {
    Write-Warning 'CI did not verify the signature chain (a self-signed root cannot be trusted unattended): the authority is AppxDeployment validation when the widget is installed on the target machine.'
}
if ($result.configuration -ne $Configuration) { throw "build-result.json says $($result.configuration), expected $Configuration." }

Write-Step '6/6 复制 widget.msix 与三个框架依赖'
$package = [string]$result.package
Copy-Item -LiteralPath $package -Destination (Join-Path $out 'widget.msix') -Force

# 依赖包：MSBuild 把框架包放在主包旁边的 Dependencies\<arch> 下，而那里同时有 x64 / ARM / ARM64
# 三份（所以下面按包内清单的架构筛选，不认路径）。
# 这三个文件名必须和 src-tauri/build.rs / src-tauri/tauri.conf.json 里登记的路径一致 ——
# 不一致的话启动器安装包会带个空占位，装到机器上就是「这个版本没带小组件」。
$expectedDeps = @(
    'Microsoft.NET.CoreRuntime.2.2.appx',
    'Microsoft.NET.CoreFramework.Debug.2.2.appx',
    'Microsoft.VCLibs.x64.Debug.14.00.appx'
)
$depSource = @(Get-ChildItem (Split-Path -Parent $package) -Recurse -File -Filter '*.appx' |
    Where-Object { $_.DirectoryName -match '[\\/]Dependencies[\\/]' })
if ($Configuration -ne 'Debug') {
    # Release 会换成非 Debug 的框架包（名字也不同），那时记得同步改上面两个文件里的路径。
    Write-Warning "Release 配置的依赖清单还没核对过：请把实际文件名同步进 src-tauri/build.rs 与 tauri.conf.json。"
}
# appx 就是 zip：读包内 AppxManifest.xml 的 Identity/ProcessorArchitecture 来认架构。
# 为什么不能按名字取第一个（2026-10-03 真机踩的坑）：Microsoft.NET.CoreRuntime.2.2.appx 与
# Microsoft.NET.CoreFramework.Debug.2.2.appx 这两个文件名里**不带架构**，Dependencies 下
# x64/ARM/ARM64 三份完全同名（只有 VCLibs 的名字自带 x64），Get-ChildItem -Recurse 先命中的
# 往往是 ARM。那样打出来的安装包：x64 机器装依赖报 0x80073D10「此程序包需要体系结构 ARM」，
# 紧接着小组件报 0x80073CF3「找不到框架」—— 两句都看不出是 payload 带错了架构。
# 用 GetAttribute 而不是直接取属性：Set-StrictMode -Latest 下访问不存在的 XML 属性会抛错，
# 而 neutral 清单本来就不写这个属性。
function Get-AppxArchitecture([string]$Path) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entry = $zip.GetEntry('AppxManifest.xml')
        if ($null -eq $entry) { return '' }
        $reader = [System.IO.StreamReader]::new($entry.Open())
        try { [xml]$inner = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $identity = $inner.Package.Identity
        if ($null -eq $identity) { return '' }
        return $identity.GetAttribute('ProcessorArchitecture')
    } finally { $zip.Dispose() }
}

$missing = @()
foreach ($name in $expectedDeps) {
    $candidates = @($depSource | Where-Object { $_.Name -eq $name })
    $picked = $null
    $pickedArch = ''
    foreach ($candidate in $candidates) {
        $arch = Get-AppxArchitecture $candidate.FullName
        # 只要 x64，以及不写架构（neutral）的；ARM/ARM64/x86 一律不收。
        if ($arch -eq 'x64' -or [string]::IsNullOrWhiteSpace($arch)) {
            $picked = $candidate
            $pickedArch = $arch
            break
        }
    }
    if ($null -eq $picked) {
        $seen = @($candidates | ForEach-Object { $_.Name + '[' + (Get-AppxArchitecture $_.FullName) + ']' }) -join ', '
        if ($seen -eq '') { $seen = 'none' }
        $missing += "$name (candidates: $seen)"
        continue
    }
    if ($pickedArch -eq '') { $pickedArch = 'neutral' }
    Copy-Item -LiteralPath $picked.FullName -Destination (Join-Path $depsOut $name) -Force
    # 这一行是唯一能一眼确认「带出去的依赖是什么架构」的地方，别删。
    Write-Host ("  {0}  arch={1}  {2} bytes" -f $name, $pickedArch, $picked.Length)
}
if ($missing.Count -gt 0) {
    $actual = @($depSource | ForEach-Object { $_.Name + '[' + (Get-AppxArchitecture $_.FullName) + ']' }) -join ', '
    throw "No x64 build of: $($missing -join '; '). Found: $actual"
}

# 顺手把小组件清单里声明的框架依赖打出来：漏带一个，装到机器上只会报「缺依赖」，很难对上号。
$widgetZip = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $out 'widget.msix'))
try {
    $widgetManifestEntry = $widgetZip.GetEntry('AppxManifest.xml')
    $widgetManifestReader = [System.IO.StreamReader]::new($widgetManifestEntry.Open())
    try { [xml]$widgetManifest = $widgetManifestReader.ReadToEnd() } finally { $widgetManifestReader.Dispose() }
    foreach ($dependency in @($widgetManifest.SelectNodes('/Package/Dependencies/PackageDependency'))) {
        Write-Host ("  widget requires: {0} >= {1}" -f $dependency.GetAttribute('Name'), $dependency.GetAttribute('MinVersion'))
    }
} finally { $widgetZip.Dispose() }

# 手动补救用的说明：安装器那一步失败时，用户/我们自己能照这个在本机装一遍。
$install = @"
FantasyHub Game Bar widget payload ($Configuration)

这个目录是给「FantasyHub 启动器安装包」用的：装启动器时会自动把小组件注册到当前用户，
不需要管理员、也不需要开发人员模式（包已签名，证书会装进当前用户的「受信任人」）。

要手动装（比如排查问题），在 Windows PowerShell 里 cd 到这个目录，然后：

  Import-Certificate -FilePath .\widget.cer -CertStoreLocation Cert:\CurrentUser\TrustedPeople
  Add-AppxPackage -Path .\deps\Microsoft.NET.CoreRuntime.2.2.appx
  Add-AppxPackage -Path .\deps\Microsoft.NET.CoreFramework.Debug.2.2.appx
  Add-AppxPackage -Path .\deps\Microsoft.VCLibs.x64.Debug.14.00.appx
  Add-AppxPackage -Path .\widget.msix

装完按 Ctrl+Shift+Esc 结束 GameBar.exe（Game Bar 只在启动时枚举小组件），再按 Win+G
就能在小组件菜单里看到 FantasyHub。

注意：
- 这份 msix 用 CI 现场生成的自签证书签的，每次构建都不一样。换新的 msix 之前要
  Remove-AppxPackage FantasyHub.GameBar，否则会报 0x80073CF9（换证书签的包不能覆盖安装）。
- 三个 deps 是小组件的框架依赖，目标机通常没有；少了它们 Add-AppxPackage 会报缺依赖。
- 失败原因看 %APPDATA%\handheld-launcher\widget-last-error.txt（启动器自己装的时候写的）。
"@
Set-Content -LiteralPath (Join-Path $out 'INSTALL.txt') -Value $install -Encoding UTF8

[ordered]@{
    configuration = $Configuration
    version = $widgetVersion
    launcherVersion = $launcherVersion
    publisher = $publisher
    name = [string]$result.name
    package = (Join-Path $out 'widget.msix')
    sha256 = (Get-FileHash (Join-Path $out 'widget.msix') -Algorithm SHA256).Hash
    certificateThumbprint = $cert.Thumbprint
    certificate = $cerPath
    dependencies = $expectedDeps
    signed = [bool]$result.signed
    chainVerified = [bool]$result.chainVerified
    generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
} | ConvertTo-Json | Set-Content (Join-Path $out 'widget-payload.json') -Encoding UTF8

Write-Host "Widget payload for the launcher installer:"
Get-ChildItem $out -Recurse -File | ForEach-Object { Write-Host ("  {0}  ({1} bytes)" -f $_.FullName.Substring($out.Length + 1), $_.Length) }
Write-Host "Version $widgetVersion ($Configuration), certificate $($cert.Thumbprint)"
