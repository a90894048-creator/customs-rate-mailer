# =============================================
# 관세청 환율 알리미 - 서버 PC 자동 설치 스크립트
# 실행: PowerShell에서 아래 한 줄 실행
#   irm https://raw.githubusercontent.com/a90894048-creator/customs-rate-mailer/master/setup.ps1 | iex
# =============================================

$ErrorActionPreference = "Stop"
$AppDir = Join-Path ([Environment]::GetFolderPath("Desktop")) "환율 알리미"
$RepoZip = "https://github.com/a90894048-creator/customs-rate-mailer/archive/refs/heads/master.zip"

Write-Host ""
Write-Host "=== 관세청 환율 알리미 설치 시작 ===" -ForegroundColor Cyan
Write-Host "설치 위치: $AppDir"
Write-Host ""

# 1. Node.js 확인 / 설치
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "[1/5] Node.js가 없습니다. 설치합니다..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Host "Node.js 설치 후 PowerShell을 새로 열고 이 스크립트를 다시 실행해주세요." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[1/5] Node.js 확인됨: $(node --version)" -ForegroundColor Green
}

# 2. 코드 다운로드
Write-Host "[2/5] 최신 코드 다운로드 중..." -ForegroundColor Cyan
$tmpZip = Join-Path $env:TEMP "customs-rate-mailer.zip"
$tmpDir = Join-Path $env:TEMP "customs-rate-mailer-extract"
Invoke-WebRequest -Uri $RepoZip -OutFile $tmpZip -UseBasicParsing
if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force

# 3. 앱 폴더로 복사 (data 폴더는 보존)
Write-Host "[3/5] 파일 설치 중..." -ForegroundColor Cyan
if (-not (Test-Path $AppDir)) { New-Item -ItemType Directory -Path $AppDir | Out-Null }
$src = Get-ChildItem $tmpDir -Directory | Select-Object -First 1
Get-ChildItem $src.FullName | Where-Object { $_.Name -ne "data" } | ForEach-Object {
    Copy-Item $_.FullName -Destination $AppDir -Recurse -Force
}
Remove-Item $tmpZip -Force
Remove-Item $tmpDir -Recurse -Force

# 4. 의존성 설치
Write-Host "[4/5] 패키지 설치 중 (1~2분)..." -ForegroundColor Cyan
Push-Location $AppDir
npm install --omit=dev --silent
Pop-Location

# 5. 자동 시작 등록 (로그온 시 백그라운드 실행)
Write-Host "[5/5] 자동 시작 등록 중..." -ForegroundColor Cyan
$vbsPath = Join-Path $AppDir "start-hidden.vbs"
@"
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "$AppDir"
WshShell.Run "cmd /c node server.js >> server.log 2>&1", 0, False
"@ | Out-File -FilePath $vbsPath -Encoding Default

$startupDir = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDir "환율알리미.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "wscript.exe"
$shortcut.Arguments = "`"$vbsPath`""
$shortcut.WorkingDirectory = $AppDir
$shortcut.Save()

# 기존 실행 중인 서버 종료 후 시작
Get-Process node -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -like "*server.js*" } catch { $false }
} | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Process wscript.exe -ArgumentList "`"$vbsPath`""
Start-Sleep -Seconds 3

Write-Host ""
Write-Host "=== 설치 완료! ===" -ForegroundColor Green
Write-Host ""
Write-Host "관리 화면:  http://localhost:3099" -ForegroundColor Cyan
Write-Host "(다른 PC에서: http://$((Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -like '192.168.*'} | Select-Object -First 1).IPAddress):3099)"
Write-Host ""
Write-Host "다음 단계:"
Write-Host "  1. 브라우저에서 관리 화면 접속"
Write-Host "  2. Gmail 주소 + 앱 비밀번호 입력 후 저장"
Write-Host "  3. 수신자 이메일 추가"
Write-Host "  4. '지금 발송하기'로 테스트"
Write-Host ""
Write-Host "매주 금요일 오전 11시에 자동 발송됩니다."
Write-Host "PC 재부팅 후에도 자동으로 시작됩니다."
