@echo off
setlocal enabledelayedexpansion
set "PORT=3210"
echo 正在查找占用端口 %PORT% 的进程...

set "PIDS= "
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% "') do (
    if not "%%a"=="0" if "!PIDS: %%a =!"=="!PIDS!" (
        set "PIDS=!PIDS!%%a "
        echo 找到进程 PID: %%a ,正在结束...
        taskkill /F /PID %%a
    )
)

if "!PIDS!"==" " (
    echo 端口 %PORT% 当前没有被占用,无需处理~
) else (
    echo 全部搞定!
)

pause