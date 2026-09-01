@echo off
chcp 65001 >nul
pushd "%~dp0"
echo 正在初始化数据库、加密密钥和H盘恢复包……
npm run init
echo.
echo 完成后请运行“⑤系统体检.cmd”。
pause
