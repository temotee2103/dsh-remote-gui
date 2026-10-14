# 建 GitHub 仓库并推送（首次发布用）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\plugins\dsh-remote-gui\publish\release.ps1"
$ErrorActionPreference = 'Stop'

$gh = "$env:LOCALAPPDATA\gh\bin\gh.exe"
$repoDir = Split-Path $PSScriptRoot -Parent
$repo = 'temotee2103/dsh-remote-gui'

Write-Host "=== 0. 前置检查 ==="
if (-not (Test-Path $gh)) { Write-Host "找不到 gh.exe: $gh" -ForegroundColor Red; exit 1 }
$auth = & $gh auth status 2>&1 | Out-String
if ($auth -notmatch 'Logged in to github.com') { Write-Host "gh 未登录" -ForegroundColor Red; exit 1 }
Write-Host ("  gh: " + (& $gh --version 2>&1 | Select-Object -First 1))

Write-Host ""
Write-Host "=== 1. 提交前最后一次语法与结构检查 ==="
foreach ($f in @('lib\index.js', 'client.js')) {
    $src = Join-Path $repoDir $f
    $tmp = Join-Path $env:TEMP ("rel-" + ($f -replace '[\\/]', '-') + ".mjs")
    Copy-Item $src $tmp -Force
    node --check $tmp 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host ("  " + $f + " 语法 OK") } else { Write-Host ("  " + $f + " 语法错误！中止") -ForegroundColor Red; exit 1 }
}
$pkg = Get-Content (Join-Path $repoDir 'package.json') -Raw | ConvertFrom-Json
if (-not $pkg.dsh.bundle.patch) { Write-Host "  package.json 缺 dsh.bundle.patch，市场会拒（中止）" -ForegroundColor Red; exit 1 }
Write-Host ("  dsh.bundle.patch = " + $pkg.dsh.bundle.patch + "  ✓")
if ($pkg.private) { Write-Host "  package.json 仍是 private，npm 发不出去（中止）" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== 2. git 提交 ==="
& git -C $repoDir add -A
& git -C $repoDir -c core.quotepath=false status --short | Select-Object -First 20 | ForEach-Object { Write-Host ("  " + $_) }
$msg = @"
feat: SSH-tunnel remote GUI panel for DSH with local/remote switching

- host half: host registry, SSH tunnel lifecycle (watchdog reconnect, adopt on restart),
  remote credential exchange (launch token -> authority-bound browser cookie),
  typert RPC (/api/<ns>/<method> with payload.args._request), 9 routes, agent tool
- client half: sidebar.footer.action slot entry, overlay panel with host management,
  remote session list, embedded remote GUI iframe (seedUrl primes the cookie),
  local-instance <-> remote switch (persisted)
- implements the DSH 0.2.x contract that dsh-sev 0.3.4 targets as 0.1.x
"@
& git -C $repoDir commit -q -m $msg
Write-Host ("  提交完成: " + (& git -C $repoDir log -1 --oneline))

Write-Host ""
Write-Host "=== 3. 建仓库并推送 ==="
& $gh repo create $repo --public --source $repoDir --remote origin --push `
    --description "Embed a remote DeepSeek Harness GUI in the local DSH window over an SSH tunnel, with remote session listing and local/remote switching." 2>&1 |
    ForEach-Object { Write-Host ("  " + $_) }

Write-Host ""
Write-Host "=== 4. 加 topics（市场要求必须有 dsh-plugin）==="
& $gh repo edit $repo --add-topic dsh-plugin --add-topic dsh --add-topic deepseek-harness --add-topic ssh-tunnel 2>&1 |
    ForEach-Object { Write-Host ("  " + $_) }

Write-Host ""
Write-Host "=== 5. 核对 ==="
& $gh repo view $repo --json name,url,visibility,repositoryTopics,createdAt 2>&1 | ForEach-Object { Write-Host ("  " + $_) }
Write-Host ""
Write-Host ("仓库创建时间（awesome-dsh-plugin 要求满 1 天才能提 PR）:")
& $gh api ("repos/" + $repo) --jq ".created_at" 2>&1 | ForEach-Object { Write-Host ("  " + $_) }
