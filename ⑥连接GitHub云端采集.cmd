@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0采集程序\scripts\setup-github.ps1"
pause

