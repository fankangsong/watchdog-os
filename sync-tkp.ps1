# 同步到 tkp 服务器（/root/srv-dashboard，端口 1234）
# 用法： ./sync-tkp.ps1
# 前置：已配置 ssh 别名 tkp；远端 run.sh 由 systemd 驱动
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$remote = 'tkp'
$remoteDir = '/root/srv-dashboard'

Write-Host '[1/5] 构建前端...'
Push-Location $root
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw '构建失败，中止同步' }
Pop-Location

Write-Host '[2/5] 清理远端 dist 并上传...'
ssh $remote "rm -rf $remoteDir/dist/*"
scp -r "$root\dist\*" "${remote}:$remoteDir/dist/"

Write-Host '[3/5] 上传 server.js / package.json / run.sh（不覆盖远端 config.json）...'
scp "$root\server.js" "$root\package.json" "$root\run.sh" "${remote}:$remoteDir/"

Write-Host '[4/5] 远端重启服务...'
ssh $remote "cd $remoteDir && ./run.sh restart"

Write-Host '[5/5] 验证...'
Start-Sleep -Seconds 2
ssh $remote "curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:1234/tkp/ && systemctl is-active srv-dashboard"
Write-Host '同步完成'
