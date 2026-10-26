@echo off
cd /d "%~dp0"
node travel-time.js >> "%~dp0travel-time.log" 2>&1
