# 把 dsh-remote-gui 装进 desktop profile，并做组装校验
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\plugins\dsh-remote-gui\install.ps1"
$ErrorActionPreference = 'Stop'

$pluginDir = $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$profilePkg = Join-Path $profileDir 'package.json'
$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$bundleName = 'dsh-remote-gui'

Write-Host "=== 1. 前置检查 ==="
foreach ($f in @('package.json', 'cordis.patch.yml', 'lib\index.js', 'client.js')) {
    $p = Join-Path $pluginDir $f
    if (Test-Path $p) { Write-Host ("  OK   " + $f) } else { Write-Host ("  缺失 " + $f) -ForegroundColor Red; $missing = $true }
}
if ($missing) { Write-Host "缺少文件，中止。" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== 2. 备份 profile 的 package.json ==="
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bk = "$profilePkg.bak-before-remote-gui-$stamp"
Copy-Item $profilePkg $bk
Write-Host ("  " + $bk)

Write-Host ""
Write-Host "=== 3. 安装依赖（link: 指向插件目录）==="
$spec = "link:$pluginDir"
Write-Host ("  spec = " + $spec)
& $dsh plugin --profile desktop add $spec 2>&1 | Select-Object -Last 8
Write-Host ("  退出码: " + $LASTEXITCODE)

Write-Host ""
Write-Host "=== 4. 登记 bundle（CLI 不会做这一步）==="
$txt = [System.IO.File]::ReadAllText($profilePkg, [System.Text.Encoding]::UTF8)
$json = $txt | ConvertFrom-Json
$bundles = @($json.dsh.profile.bundles)
if ($bundles -contains $bundleName) {
    Write-Host "  已在 bundles 里"
} else {
    $bundles += $bundleName
    $json.dsh.profile.bundles = $bundles
    $out = $json | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($profilePkg, $out, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ("  已加入: " + ($bundles -join ', '))
}

Write-Host ""
Write-Host "=== 5. 组装校验（dump-config；这一步能抓出 patch 引用不存在的问题）==="
$dump = & $dsh --profile desktop --dump-config 2>&1
$dumpText = $dump -join "`n"
if ($dumpText -match $bundleName) {
    Write-Host ("  组装结果里出现 " + $bundleName + " ✓")
    ($dumpText -split "`n" | Select-String -Pattern $bundleName -Context 0,2 | Select-Object -First 3) | ForEach-Object { Write-Host ("    " + $_.Line.Trim()) }
} else {
    Write-Host "  !! 组装结果里没有它，安装没生效" -ForegroundColor Red
    ($dumpText -split "`n" | Select-Object -Last 8) | ForEach-Object { Write-Host ("    " + $_) }
}

Write-Host ""
Write-Host "完成。宿主半边需要重启 DSH Desktop 才加载。" -ForegroundColor Yellow
