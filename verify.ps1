# 重启 DSH Desktop 之后跑这个，验证 dsh-remote-gui 是否真的挂载了
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\plugins\dsh-remote-gui\verify.ps1"
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:19387'

Write-Host "=== 0. 应用在跑吗 ==="
$procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
Write-Host ("  进程数: " + @($procs).Count)
$listen = (Get-NetTCPConnection -LocalPort 19387 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host ("  19387 监听: " + $listen)
if ($listen -eq 0) { Write-Host "  本地 harness 没在监听，先确认应用起来了。" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== 1. 宿主半边是否挂载（这是最硬的判据）==="
$code = curl.exe -s -o "$env:TEMP\rg-verify-hosts.json" -w "%{http_code}" --max-time 20 "$base/api/dsh-remote-gui/hosts"
Write-Host ("  GET /api/dsh-remote-gui/hosts -> HTTP " + $code)
if ($code -eq '200') {
    Write-Host "  宿主半边已挂载 ✓" -ForegroundColor Green
    Get-Content "$env:TEMP\rg-verify-hosts.json" -Raw
} elseif ($code -eq '401') {
    Write-Host "  401 = 路由还没注册（插件没挂载）→ 应用没重启，或组合没生效" -ForegroundColor Yellow
} elseif ($code -eq '404') {
    Write-Host "  404 = 插件根本没进组合（bundles 登记或包解析有问题）" -ForegroundColor Red
} else {
    Write-Host ("  非预期: " + $code) -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== 2. 客户端半边是否被服务出来 ==="
$c2 = curl.exe -s -o NUL -w "%{http_code}" --max-time 15 "$base/plugins/dsh-remote-gui/client.js"
Write-Host ("  GET /plugins/dsh-remote-gui/client.js -> HTTP " + $c2)
if ($c2 -eq '200') { Write-Host "  客户端半边已被服务 ✓（侧栏应该出现页脚图标）" -ForegroundColor Green }
elseif ($c2 -eq '404') { Write-Host "  404 = 客户端模块没注册（检查 package.json 的 dsh.client 与 exports 的 ./client）" -ForegroundColor Red }
else { Write-Host ("  非预期: " + $c2) -ForegroundColor Yellow }

Write-Host ""
Write-Host "=== 3. 用 API 直接建一台主机并看远端会话（不依赖界面）==="
$body = '{"alias":"100.69.133.94","name":"VPS goeasy","port":3080,"localPort":5641,"autoTunnel":true}'
[System.IO.File]::WriteAllText("$env:TEMP\rg-add.json", $body, (New-Object System.Text.UTF8Encoding($false)))
$add = curl.exe -s --max-time 25 -X POST -H "content-type: application/json" --data-binary "@$env:TEMP\rg-add.json" "$base/api/dsh-remote-gui/hosts"
Write-Host ("  POST /hosts -> " + $add)
Start-Sleep -Seconds 6
$sess = curl.exe -s --max-time 40 "$base/api/dsh-remote-gui/sessions?id=100.69.133.94"
$count = ([regex]::Match($sess, '"sessionId"')).Count
Write-Host ("  GET /sessions -> 拿到 " + $count + " 个会话")
if ($count -gt 0) { Write-Host "  远端会话列表可用 ✓" -ForegroundColor Green }
else { Write-Host ("  没拿到会话，原始响应前 300 字: " + $sess.Substring(0, [Math]::Min(300, $sess.Length))) -ForegroundColor Yellow }

Write-Host ""
Write-Host "=== 4. 人工确认（脚本查不到的）==="
Write-Host "  侧栏页脚是否出现「远程」图标；点开后面板里是否列出远端会话、iframe 是否显示远端 GUI。"
