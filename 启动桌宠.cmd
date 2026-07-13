@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Memory Pet Agent Launcher

rem Always run from the project directory, even when opened by double-click.
cd /d "%~dp0"

echo ========================================
echo   Memory Pet Agent - Windows Launcher
echo ========================================
echo.

if not exist "package.json" (
  echo [ERROR] package.json was not found.
  echo Keep this script in the project root directory.
  goto :failed
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or is not available in PATH.
  echo Install Node.js 22 or newer from https://nodejs.org/
  goto :failed
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm is not installed or is not available in PATH.
  echo Reinstall Node.js with npm enabled.
  goto :failed
)

for /f %%V in ('node -p "parseInt(process.versions.node.split('.')[0], 10)"') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
  echo [ERROR] Unable to detect the Node.js version.
  goto :failed
)
if %NODE_MAJOR% LSS 22 (
  echo [ERROR] Node.js 22 or newer is required. Current version:
  node --version
  goto :failed
)

echo [OK] Node.js detected:
node --version
echo.

set "NEED_INSTALL=0"
if not exist "node_modules\.bin\vite.cmd" set "NEED_INSTALL=1"
if not exist "node_modules\electron\dist\electron.exe" set "NEED_INSTALL=1"
if not exist "node_modules\pixi.js\package.json" set "NEED_INSTALL=1"
if not exist "node_modules\untitled-pixi-live2d-engine\package.json" set "NEED_INSTALL=1"
if not exist "node_modules\sherpa-onnx\package.json" set "NEED_INSTALL=1"

if "%NEED_INSTALL%"=="1" (
  echo [INFO] Dependencies are missing. Installing them now...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call npm install
  if errorlevel 1 goto :install_failed
)

rem Electron 43 can defer its binary download; make sure the executable exists.
if not exist "node_modules\electron\dist\electron.exe" (
  if not exist "node_modules\electron\install.js" goto :install_failed
  echo [INFO] Downloading the Electron runtime...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  node "node_modules\electron\install.js"
  if errorlevel 1 goto :install_failed
)

set "ASR_DIR=resources\voice\sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23"
set "NEED_ASR_MODEL=0"
if not exist "%ASR_DIR%\encoder-epoch-99-avg-1.int8.onnx" set "NEED_ASR_MODEL=1"
if not exist "%ASR_DIR%\decoder-epoch-99-avg-1.onnx" set "NEED_ASR_MODEL=1"
if not exist "%ASR_DIR%\joiner-epoch-99-avg-1.int8.onnx" set "NEED_ASR_MODEL=1"
if not exist "%ASR_DIR%\tokens.txt" set "NEED_ASR_MODEL=1"
if "%NEED_ASR_MODEL%"=="1" (
  echo [INFO] Local Chinese speech model is missing. Downloading it into this project directory...
  call npm run voice:model:download
  if errorlevel 1 goto :model_failed
)

if /i "%~1"=="--check" (
  echo [OK] Launcher check passed. The project is ready to start.
  endlocal
  exit /b 0
)

echo [INFO] Building and starting the desktop pet...
echo [INFO] Closing the window hides it to the system tray. Use the tray menu to exit.
echo.
call npm start
set "APP_EXIT_CODE=%ERRORLEVEL%"

if not "%APP_EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] The desktop pet exited with code %APP_EXIT_CODE%.
  goto :failed_with_code
)

endlocal
exit /b 0

:install_failed
echo.
echo [ERROR] Dependency installation failed.
echo Check the network connection and run this script again.
goto :failed

:model_failed
echo.
echo [ERROR] Local speech model download failed.
echo All model files must remain under this project: %CD%\resources\voice
goto :failed

:failed
set "APP_EXIT_CODE=1"

:failed_with_code
echo.
pause
endlocal & exit /b %APP_EXIT_CODE%
