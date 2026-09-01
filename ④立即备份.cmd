@echo off
chcp 65001 >nul
pushd "%~dp0"
npm run backup
pause
