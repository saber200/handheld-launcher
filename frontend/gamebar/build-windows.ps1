[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Release',
    [string]$MSBuildPath,
    [string]$CertificateThumbprint,
    [string]$TimestampUrl,
    # 跳过最后的 `signtool verify /pa`。**为什么需要这个开关**：verify 要把证书链走到信任根，
    # 而自签证书的根必须先写进信任存储 —— 在 Windows 上往 Root 存储写证书（Import-Certificate、
    # X509Store.Add 都一样，底层是同一个 API）会弹「安全警告」等用户点确认；无人值守的 CI 上
    # 没人点，那一步会永久挂住（实测只能人工取消）。所以 CI 跳过链验证；签名是否有效最终由
    # 目标机安装时的 AppxDeployment 校验决定（那才是权威裁判）。
    [switch]$SkipVerify
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This script requires Windows and Visual Studio UWP build tools.' }
if ($TimestampUrl -and -not $CertificateThumbprint) { throw 'TimestampUrl requires CertificateThumbprint.' }
$root = $PSScriptRoot
$bridge = Join-Path $root 'Bridge\FantasyHub.GameBar.Bridge.csproj'
$widget = Join-Path $root 'Widget\FantasyHub.GameBar.Widget.csproj'
if (-not $MSBuildPath) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { throw 'Install Visual Studio 2022 with UWP C#/.NET Native, SDK 22621 and .NET Framework 4.8 targeting pack.' }
    $found = @(& $vswhere -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe')
    if ($LASTEXITCODE -ne 0 -or $found.Count -eq 0) { throw 'Visual Studio MSBuild not found.' }
    $MSBuildPath = $found[0]
}
if (-not (Test-Path $MSBuildPath -PathType Leaf)) { throw 'MSBuildPath must point to MSBuild.exe, not dotnet.exe.' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $root ('AppPackages\' + $Configuration + '-' + $stamp + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $out | Out-Null
function Invoke-Build([string[]]$Arguments) {
    & $MSBuildPath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "MSBuild failed ($LASTEXITCODE). Packaging stopped." }
}
# Restore each graph explicitly; the UWP target also builds Bridge, not its restore graph.
# Never run these steps concurrently or use dotnet publish for this classic UWP project.
$common = @('/nologo', '/m:1', '/nr:false', "/p:Configuration=$Configuration", '/p:Platform=x64')
Invoke-Build (@($bridge, '/t:Restore') + $common)
Invoke-Build (@($widget, '/t:Restore') + $common)
Invoke-Build (@($bridge, '/t:Build') + $common)
$packageDir = $out.Replace('\', '/') + '/' # Avoid a trailing backslash before native argument quoting.
Invoke-Build (@($widget, '/t:Build', '/p:GenerateAppxPackageOnBuild=true', '/p:AppxBundle=Never', '/p:UapAppxPackageBuildMode=SideloadOnly', '/p:AppxPackageSigningEnabled=false', "/p:AppxPackageDir=$packageDir") + $common)
$packages = @(Get-ChildItem $out -Recurse -File | Where-Object {
    $_.Extension -in '.appx', '.msix' -and $_.FullName -notmatch '[\\/]Dependencies[\\/]'
})
if ($packages.Count -ne 1) { throw "Expected one main x64 package; found $($packages.Count). Inspect $out" }
$package = $packages[0]
# Inspect the produced artifact instead of assuming the nested Bridge build was packaged.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($package.FullName)
try {
    $names = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    foreach ($required in @('AppxManifest.xml', 'Bridge/FantasyHub.GameBar.Bridge.exe', 'Bridge/FantasyHub.GameBar.Bridge.exe.config', 'GameBar/index.txt', 'Assets/Sounds/click.wav', 'Assets/Sounds/done.wav', 'Assets/Sounds/tdp-up.wav', 'Assets/Sounds/tdp-down.wav')) {
        if ($required -notin $names) { throw "Package is missing $required" }
    }
    $entry = $zip.GetEntry('AppxManifest.xml')
    $reader = [IO.StreamReader]::new($entry.Open())
    try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if ($manifest.Package.Identity.ProcessorArchitecture -ne 'x64') { throw 'Package architecture is not x64.' }
    $publisher = [string]$manifest.Package.Identity.Publisher
    $ns = [Xml.XmlNamespaceManager]::new($manifest.NameTable)
    $ns.AddNamespace('p', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
    $ns.AddNamespace('uap', 'http://schemas.microsoft.com/appx/manifest/uap/windows10')
    $ns.AddNamespace('uap3', 'http://schemas.microsoft.com/appx/manifest/uap/windows10/3')
    $ns.AddNamespace('desktop', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10')
    $apps = @($manifest.SelectNodes('/p:Package/p:Applications/p:Application', $ns))
    if ($apps.Count -ne 1) { throw 'Expected one UWP application.' }
    $applicationId = $apps[0].GetAttribute('Id')
    $extensions = @($apps[0].SelectNodes('p:Extensions/uap3:Extension/uap3:AppExtension', $ns))
    if ($extensions.Count -ne 1 -or $extensions[0].GetAttribute('Name') -ne 'microsoft.gameBarUIExtension') {
        throw 'Game Bar application extension missing or ambiguous.'
    }
    $appExtensionId = $extensions[0].GetAttribute('Id')
    $services = @($apps[0].SelectNodes('p:Extensions/uap:Extension/uap:AppService', $ns))
    if ($services.Count -ne 1) { throw 'Expected one in-process AppService.' }
    $appService = $services[0].GetAttribute('Name')
    if ($applicationId -ne 'App' -or $appExtensionId -ne 'FantasyHubWidget' -or $appService -ne 'FantasyHub.WidgetBridge') {
        throw 'Packaged activation identity does not match the C# contract.'
    }
    $serviceEntryPoint = $services[0].ParentNode.GetAttribute('EntryPoint')
    if ($serviceEntryPoint -and $serviceEntryPoint -ne $apps[0].GetAttribute('EntryPoint')) {
        throw 'AppService must use the UWP in-process background activation entry point.'
    }
    $fullTrust = @($apps[0].SelectNodes('p:Extensions/desktop:Extension[@Category="windows.fullTrustProcess"]', $ns))
    if ($fullTrust.Count -ne 1 -or $fullTrust[0].GetAttribute('Executable') -ne 'Bridge\FantasyHub.GameBar.Bridge.exe') {
        throw 'Full-trust Bridge extension missing or invalid.'
    }
    # .NET Native may transform metadata. Validate the actual proxy paths emitted
    # in the packaged manifest rather than assuming the source WinMD survives.
    $proxies = @($manifest.SelectNodes('/p:Package/p:Extensions/p:Extension[@Category="windows.activatableClass.proxyStub"]/p:ProxyStub', $ns))
    if ($proxies.Count -eq 0) { throw 'Game Bar proxy registration is missing.' }
    foreach ($proxy in $proxies) {
        $proxyPath = $proxy.SelectSingleNode('p:Path', $ns)
        if ($null -eq $proxyPath -or $proxyPath.InnerText.Replace('\', '/') -notin $names) {
            throw 'A packaged proxy registration references missing metadata.'
        }
    }
    $configEntry = $zip.GetEntry('Bridge/FantasyHub.GameBar.Bridge.exe.config')
    $configReader = [IO.StreamReader]::new($configEntry.Open())
    try { [xml]$bridgeConfig = $configReader.ReadToEnd() } finally { $configReader.Dispose() }
    $runtime = $bridgeConfig.SelectSingleNode('/configuration/startup/supportedRuntime')
    if ($null -eq $runtime -or $runtime.GetAttribute('version') -ne 'v4.0' -or $runtime.GetAttribute('sku') -ne '.NETFramework,Version=v4.8') {
        throw 'Packaged Bridge runtime configuration is not .NET Framework 4.8.'
    }
} finally { $zip.Dispose() }
if ($CertificateThumbprint) {
    # Use a preinstalled CurrentUser certificate; do not put a PFX password in arguments/logs.
    $thumb = $CertificateThumbprint.Replace(' ', '')
    if ($thumb -notmatch '^[0-9A-Fa-f]{40}$') { throw 'Expected a SHA-1 certificate thumbprint.' }
    $certificate = Get-Item "Cert:\CurrentUser\My\$thumb"
    if (-not $certificate.HasPrivateKey) { throw 'Signing certificate has no private key.' }
    if ($certificate.Subject -ne $publisher) { throw "Certificate Subject must match manifest Publisher: $publisher" }
    if ($certificate.NotAfter -le (Get-Date) -or $certificate.NotBefore -gt (Get-Date)) { throw 'Signing certificate is not currently valid.' }
    $signTool = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe'
    if (-not (Test-Path $signTool)) { throw 'Windows SDK 22621 x64 signtool.exe not found.' }
    $signArgs = @('sign', '/fd', 'SHA256', '/sha1', $thumb, '/s', 'My')
    if ($TimestampUrl) {
        $uri = [uri]$TimestampUrl
        if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin 'http', 'https') { throw 'TimestampUrl must be an HTTP(S) RFC3161 endpoint.' }
        $signArgs += @('/tr', $TimestampUrl, '/td', 'SHA256')
    }
    $signArgs += $package.FullName
    & $signTool @signArgs
    if ($LASTEXITCODE -ne 0) { throw 'Package signing failed.' }
    if ($SkipVerify) {
        Write-Warning 'Skipping signtool verify /pa: a self-signed root cannot be trusted unattended (writing it into the Root store pops a confirmation prompt and would hang CI forever).'
    } else {
        & $signTool verify /pa /v $package.FullName
        if ($LASTEXITCODE -ne 0) { throw 'Signature verification failed; check the certificate trust chain.' }
    }
} else {
    Write-Warning 'Unsigned package: not installable as-is. Sign with a matching trusted certificate before deployment.'
}
# Capture identity from the built manifest; never hard-code a PublisherId-derived package family.
[ordered]@{
    name = [string]$manifest.Package.Identity.Name
    publisher = $publisher
    version = [string]$manifest.Package.Identity.Version
    applicationId = $applicationId
    appExtensionId = $appExtensionId
    appService = $appService
    configuration = $Configuration
    architecture = 'x64'
    signed = [bool]$CertificateThumbprint
    chainVerified = [bool]($CertificateThumbprint -and -not $SkipVerify)
    package = $package.FullName
    sha256 = (Get-FileHash $package.FullName -Algorithm SHA256).Hash
    externalActivation = 'Not validated; obtain installed PackageFamilyName and use the documented Game Bar activation contract.'
} | ConvertTo-Json | Set-Content (Join-Path $out 'build-result.json') -Encoding UTF8
Write-Host "Package: $($package.FullName)"
Write-Host "Build result: $(Join-Path $out 'build-result.json')"
Write-Host 'Install dependencies from this output on the target device. This script does not install, change certificate trust, or launch Game Bar.'