@echo off
setlocal
set "vcvars="
set "vswhere=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%vswhere%" goto :missing
for /f "usebackq delims=" %%I in (`"%vswhere%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find VC\Auxiliary\Build\vcvars64.bat`) do set "vcvars=%%I"
if not defined vcvars goto :missing
call "%vcvars%" >nul
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /O2 /EHsc /W4 /MT /DUNICODE /D_UNICODE native\helper-windows.cpp /Fobuild\bin\helper-windows.obj /Febuild\bin\kokoro-helper.exe /link ole32.lib oleaut32.lib uiautomationcore.lib user32.lib
exit /b %errorlevel%

:missing
echo Install Visual Studio Build Tools with Desktop development with C++ and the Windows SDK. 1>&2
exit /b 1
