@echo off
chcp 65001 >nul
pushd "%~dp0"
echo 正在从获准的免费公开来源采集……
npm run collect
if errorlevel 1 goto failed
echo 正在重新评分、严格分库并生成两份Excel……
npm run export
if errorlevel 1 goto failed
echo 正在创建H盘版本化增量备份……
npm run backup
if errorlevel 1 goto failed
echo 已完成。普通热度不可复用商品没有进入研究报表。
pause
exit /b 0
:failed
echo 执行未完成，请运行“⑤系统体检.cmd”查看原因。
pause
exit /b 1
