@echo off
cd /d "%~dp0"
call "%~dp0start_server_stack.bat" Full
@echo off
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0start_u25_full_auto.bat"
