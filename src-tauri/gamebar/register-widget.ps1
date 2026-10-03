# 把 Game Bar 小组件装到「当前用户」：信任随包证书 → 装它依赖的框架包 → 注册小组件 → 重启 Game Bar。
#
# 为什么必须这么绕（而不是双击安装）：
#  1. 小组件是 msix，Windows 只收签过名的；签名用的是 CI 现打的自签证书，所以安装前得先把
#     那张证书的公钥放进「受信任人」——CurrentUser 是必须成功的那一步，LocalMachine 提权时顺带做。
#  2. UWP 包自带三个框架依赖（.NET Core Runtime、CoreFramework Debug、VCLibs Debug），
#     目标机通常没有，必须一起装；少了它们 Add-AppxPackage 会直接报缺依赖。
#  3. Game Bar 只在启动时枚举扩展：装完不重启它，Win+G 里根本看不到新小组件（用户会以为没装上）。
#
# 谁在调它：
#  - 启动器启动时（src-tauri/src/startup.rs 的 schedule_widget_registration，5 秒后台跑，幂等）
#  - 启动器设置页「装 Game Bar 小组件」（同一个文件，带 -Force 先卸再装）
#  - 手动补一次：powershell -NoProfile -File %APPDATA%\handheld-launcher\register-widget.ps1
#    -Msix <安装目录>\payload\gamebar\widget.msix -Cer <...>\widget.cer -DepsDir <...>\deps
#  - 想卸掉小组件：同一个脚本加 -Uninstall（NSIS 卸载钩子跑的是等价的一行内联命令，见
#    src-tauri/nsis/installer.nsh；那条不依赖这个文件，因为卸载时安装目录可能已经空了）
#
# 输出约定：第一行是一个英文 token（OK/SKIP/EMPTY_PAYLOAD/CERT_FAIL/DEP_FAIL/ADD_FAIL/
# NEED_DEVMODE/REMOVE_FAIL/SCRIPT_FAIL），由 Rust 侧翻成人话；细节写进
# %APPDATA%\handheld-launcher\widget-last-error.txt，装失败时照它定位。

param(
  [string]$Msix,
  [string]$Cer,
  [string]$DepsDir,
  # 卸载钩子跑的时候安装目录可能已经被清空，拿不到 msix 里的 Identity，
  # 所以这里得有个默认包名（它必须和 Widget/Package.appxmanifest 的 Identity Name 一致）。
  [string]$PackageName = 'FantasyHub.GameBar',
  [switch]$Force,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$stateDir = Join-Path $env:APPDATA 'handheld-launcher'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$detail = Join-Path $stateDir 'widget-last-error.txt'
# 记下装过的那个包长什么样（hash + 版本）：hash 没变就不动它。
# 每次 CI 都会重新签一次名，光比版本号不够（Debug 包的版本可能没变），
# 而每次都 Remove+Add 会让 Game Bar 短暂丢一次小组件。
$marker = Join-Path $stateDir 'widget-package.txt'

function Write-Detail([string]$text) { Set-Content -LiteralPath $detail -Value $text -Encoding utf8 }
function Fail([string]$token, [string]$message) { Write-Detail $message; Write-Output $token; exit 1 }
function Done([string]$token, [string]$message) { Write-Detail $message; Write-Output $token; exit 0 }

# Tauri 的 resource_dir() 常带 \\?\ 前缀，AppX API 会把它当坏 URI（FSE 登记踩过同样的坑）。
function Normalize-WinPath([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return $p }
  $p = $p.Trim().Trim('"')
  if ($p.StartsWith('\\?\UNC\')) { return ('\' + $p.Substring(8)) }
  if ($p.StartsWith('\\?\')) { return $p.Substring(4) }
  return $p
}

# 包名/版本/发布者一律从包自己的 AppxManifest.xml 里读：清单改了这里不用跟着改。
function Get-PackageIdentity([string]$packagePath) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($packagePath)
  try {
    $entry = $zip.GetEntry('AppxManifest.xml')
    if ($null -eq $entry) { return $null }
    $reader = [IO.StreamReader]::new($entry.Open())
    try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
    return [pscustomobject]@{
      Name      = [string]$manifest.Package.Identity.Name
      Version   = [version]$manifest.Package.Identity.Version
      Publisher = [string]$manifest.Package.Identity.Publisher
      # 装依赖前要先比架构（见 Install-Dependencies）：这两个 .NET 框架包的文件名里不带架构，
      # x64/ARM/ARM64 三份同名，光看文件名分不出来。
      Architecture = [string]$manifest.Package.Identity.ProcessorArchitecture
    }
  } finally { $zip.Dispose() }
}

function Get-Installed([string]$name) {
  return @(Get-AppxPackage -Name $name -ErrorAction SilentlyContinue)
}

# Game Bar 只在启动时枚举扩展，装/卸完不重启它就看不到变化。
function Restart-GameBar {
  foreach ($process in @('GameBar', 'GameBarFTServer')) {
    try { Get-Process -Name $process -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
  }
}

# 框架依赖包一个都别跳过：缺哪个，后面装小组件都会失败，而且报错信息很难懂。
# 已存在（版本够新）就跳过——这些包是微软的，别的应用可能也在用，不删不降级。
function Install-Dependencies([string]$dir) {
  $results = @()
  if ([string]::IsNullOrWhiteSpace($dir) -or -not (Test-Path -LiteralPath $dir)) {
    return @('no dependency folder shipped')
  }
  $deps = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.appx', '.msix' -and $_.Length -gt 200 })
  # 本机架构（PROCESSOR_ARCHITECTURE 在 Windows 上恒有值，PS 5.1 也能读）。
  $hostArch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    'x86'   { 'x86' }
    default { '' }
  }
  foreach ($dep in $deps) {
    $identity = Get-PackageIdentity $dep.FullName
    if ($null -eq $identity) { $results += "no manifest: $($dep.Name)"; continue }
    # 随包的框架包架构必须和本机一致。2026-10-03 真机踩过：payload 里带的是 Dependencies\ARM
    # 下的 .NET 框架包，装到 x64 机器上报 0x80073D10「此程序包需要体系结构 ARM」，紧接着小组件
    # 报 0x80073CF3「找不到框架」—— 两条报错都看不出是 payload 打错了架构。
    # 这里先自己认出来，直接说清楚是这个安装包的问题。
    $arch = [string]$identity.Architecture
    if ($arch -and $arch -ne 'neutral' -and $hostArch -and $arch -ne $hostArch) {
      $results += "FAILED: $($identity.Name): payload ships the $arch build, this machine is $hostArch (wrong payload; install a newer FantasyHub)"
      continue
    }
    $present = $false
    foreach ($package in @(Get-Installed $identity.Name)) {
      if ([version]$package.Version -ge $identity.Version) { $present = $true }
    }
    if ($present) { $results += "present: $($identity.Name) $($identity.Version)"; continue }
    try {
      Add-AppxPackage -Path $dep.FullName -ErrorAction Stop
      $results += "installed: $($identity.Name) $($identity.Version)"
    } catch {
      $results += "FAILED: $($identity.Name): $($_.Exception.Message)"
    }
  }
  if ($deps.Count -eq 0) { $results += 'dependency folder is empty (placeholder only)' }
  return $results
}

if ($Uninstall) {
  $installed = @(Get-Installed $PackageName)
  if ($installed.Count -eq 0) { Done 'SKIP' "Nothing installed for $PackageName." }
  foreach ($package in $installed) {
    try {
      Remove-AppxPackage -Package $package.PackageFullName -ErrorAction Stop
    } catch {
      Fail 'REMOVE_FAIL' "Remove-AppxPackage $($package.PackageFullName) failed: $($_.Exception.Message)"
    }
  }
  Remove-Item -LiteralPath $marker -ErrorAction SilentlyContinue
  Restart-GameBar
  Done 'OK' "Removed: $(($installed | ForEach-Object { $_.PackageFullName }) -join ', ')"
}

$Msix = Normalize-WinPath $Msix
$Cer = Normalize-WinPath $Cer
$DepsDir = Normalize-WinPath $DepsDir

if ([string]::IsNullOrWhiteSpace($Msix) -or -not (Test-Path -LiteralPath $Msix)) {
  Fail 'EMPTY_PAYLOAD' "No widget package in this build. Msix=$Msix"
}
if ((Get-Item -LiteralPath $Msix).Length -lt 200) {
  # 仓库里那个 0 字节占位（build.rs 建的空文件）就是走到这里：这个安装包没带小组件。
  Fail 'EMPTY_PAYLOAD' "Widget package is a placeholder (0 bytes): $Msix"
}
$identity = Get-PackageIdentity $Msix
if ($null -eq $identity) { Fail 'EMPTY_PAYLOAD' "Widget package has no AppxManifest.xml: $Msix" }

$hash = (Get-FileHash -LiteralPath $Msix -Algorithm SHA256).Hash
# 标记文件里三样（空格分隔）：包 hash、版本、签名证书指纹。
# 指纹是用来「只清上一次自己装进去的那张证书」的 —— 按主题清会误伤 FSE 身份证书
# （src-tauri/fse/pack.ps1 用的也是 CN=FantasyHub）。
$previous = @()
if (Test-Path -LiteralPath $marker) { $previous = @((Get-Content -LiteralPath $marker -Raw).Trim() -split '\s+') }
$previousHash = if ($previous.Count -ge 1) { $previous[0] } else { '' }
$previousThumb = if ($previous.Count -ge 3) { $previous[2] } else { '' }
$installed = @(Get-Installed $identity.Name)

$log = @(
  "package=$Msix"
  "identity=$($identity.Name) $($identity.Version) $($identity.Publisher)"
  "hash=$hash previousHash=$previousHash previousCert=$previousThumb"
  "installed=$(($installed | ForEach-Object { $_.PackageFullName }) -join ', ')"
)

if (-not $Force -and $installed.Count -gt 0 -and $previousHash -eq $hash) {
  Done 'OK' (($log + "Already installed and unchanged: $($installed[0].PackageFullName)") -join "`r`n")
}

$thumb = ''
if (Test-Path -LiteralPath $Cer) {
  try {
    $imported = Import-Certificate -FilePath $Cer -CertStoreLocation 'Cert:\CurrentUser\TrustedPeople'
  } catch {
    Fail 'CERT_FAIL' (($log + "CurrentUser TrustedPeople import failed: $($_.Exception.Message)") -join "`r`n")
  }
  $thumb = [string]$imported.Thumbprint
  # 每次 CI 都新签一张证书：上一次那张没人用了，清掉别让「受信任人」越攒越多。
  if ($previousThumb -and $previousThumb -ne $thumb) {
    foreach ($store in @('Cert:\CurrentUser\TrustedPeople', 'Cert:\LocalMachine\TrustedPeople')) {
      try {
        Remove-Item -LiteralPath "$store\$previousThumb" -Force -ErrorAction Stop
        $log += "old cert removed from $store"
      } catch {
        $log += "old cert kept in $store : $($_.Exception.Message)"
      }
    }
  }
  try {
    Import-Certificate -FilePath $Cer -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
  } catch {
    # 没提权时这一步会失败；CurrentUser 通常就够，不阻塞。
    $log += "LocalMachine cert import skipped: $($_.Exception.Message)"
  }
} else {
  $log += "no certificate shipped: $Cer"
}

$log += @(Install-Dependencies $DepsDir)

try {
  foreach ($package in $installed) {
    # 换证书签的同一个 identity，Windows 不接受覆盖安装（0x80073CF9），只能先卸再装。
    Remove-AppxPackage -Package $package.PackageFullName -ErrorAction Stop
  }
  Add-AppxPackage -Path $Msix -ErrorAction Stop
} catch {
  $text = $_.Exception.Message
  Write-Detail (($log + "Add-AppxPackage failed: $text") -join "`r`n")
  if ($text -match '80073CFF|Developer Mode|sideload|side-load|allowAllTrustedApps') { Write-Output 'NEED_DEVMODE'; exit 1 }
  if ($text -match '80073CF9|800B0109|800B0100|certificate|trusted|signature|证书') { Write-Output 'CERT_FAIL'; exit 1 }
  if ($text -match 'dependency|framework|框架|80073CF3|80073D02') { Write-Output 'DEP_FAIL'; exit 1 }
  Write-Output 'ADD_FAIL'
  exit 1
}

$check = @(Get-Installed $identity.Name)
if ($check.Count -eq 0) {
  Fail 'ADD_FAIL' (($log + 'Add-AppxPackage returned but Get-AppxPackage found nothing.') -join "`r`n")
}

Set-Content -LiteralPath $marker -Value "$hash $($identity.Version) $thumb" -Encoding ascii
Restart-GameBar
Done 'OK' (($log + "Registered: $($check[0].PackageFullName)") -join "`r`n")
