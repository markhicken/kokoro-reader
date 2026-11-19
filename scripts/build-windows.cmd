@echo off
setlocal
set "component=Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
set "target=amd64"
if "%~1"=="x64" goto :configure
if not "%~1"=="arm64" (
  echo Expected build architecture: x64 or arm64. 1>&2
  exit /b 1
)
set "component=Microsoft.VisualStudio.Component.VC.Tools.ARM64"
set "target=arm64"

:configure
set "vcvars="
set "vswhere=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%vswhere%" goto :missing
for /f "usebackq delims=" %%I in (`"%vswhere%" -latest -products * -requires %component% -find VC\Auxiliary\Build\vcvarsall.bat`) do set "vcvars=%%I"
if not defined vcvars goto :missing
call "%vcvars%" %target% >nul
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /O2 /EHsc /W4 /MT /DUNICODE /D_UNICODE native\helper-windows.cpp /Fobuild\bin\helper-windows.obj /Febuild\bin\kokoro-helper.exe /link ole32.lib oleaut32.lib uiautomationcore.lib user32.lib
exit /b %errorlevel%

:missing
echo Install Visual Studio Build Tools with Desktop development with C++, the %~1 compiler tools, and the Windows SDK. 1>&2
exit /b 1
