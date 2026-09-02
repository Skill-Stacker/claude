@echo off
setlocal EnableExtensions DisableDelayedExpansion
title StickOS - Start Button

REM ============================================================
REM   ONE BUTTON. Double-click this and StickOS sets itself up
REM   (first time) then launches. Nothing else to do, ever.
REM   Everything stays on this USB; the app server is 127.0.0.1
REM   only.
REM
REM   This launcher only fetches portable Node. Once Node is
REM   ready it starts app\server.js, and the server does every
REM   other download (the AI engine, the model, voices, speech)
REM   with a progress bar in the browser, not in this window.
REM
REM   NOTE FOR EDITORS: never "set" a variable and read it back
REM   with %VAR% inside the same ( ... ) block -- cmd expands the
REM   whole block before it runs, so you get an empty string.
REM   That is why the setup steps below are :subroutines reached
REM   with "call". Also, a backslash placed right before a closing
REM   quote is read as an escaped quote, not a path separator, so
REM   no path or argument in this file may end that way, and the
REM   browser is never started through "start" with two quoted
REM   arguments in a row (it launches nothing and still exits 0).
REM   See CLAUDE.md, "Launcher traps".
REM ============================================================

REM  %~dp0 always ends in a backslash, so this trim is unconditional
REM  on purpose; nothing here compares against a lone backslash.
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

REM ---- Node version pinned in app/manifest.json. build-installer
REM ---- keeps the version and URL below in sync with that file;
REM ---- do not point this at a floating tag. ----
set "NODE_VERSION=24.20.0"
set "NODE_ZIP_NAME=node-v24.20.0-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip"
set "NODE_SHASUMS=https://nodejs.org/dist/v24.20.0/SHASUMS256.txt"

cls
echo.
echo    ================================================
echo        S T I C K O S      *  Start Button  *
echo        your private assistant, running from this USB
echo    ================================================
echo.

call :capture_realhome
call :redirect_env
call :make_dirs
call :preflight_write
if not defined PFOK goto :no_write

REM ================= 1) NODE (portable runtime) =================
call :find_node
if defined NODE_EXE goto :node_ok
call :get_node
call :find_node
if not defined NODE_EXE goto :node_missing
echo    [1/3] Node runtime .... ready
goto :node_done
:node_ok
echo    [1/3] Node runtime .... found
:node_done

REM ================= 2) APP (server + web UI) =================
call :find_app
if defined APP_OK goto :app_ok
call :get_app
if not defined APP_OK goto :app_missing
echo    [2/3] StickOS app ..... ready
goto :app_done
:app_ok
echo    [2/3] StickOS app ..... found
:app_done

REM ================= 3) LAUNCH =================
REM  A stale port.txt from an earlier run would make the opener
REM  helper below open an old, no-longer-listening port, so clear
REM  it before the server has a chance to write a fresh one.
if exist "%ROOT%\state\port.txt" del /f /q "%ROOT%\state\port.txt" >nul 2>&1

call :find_browser
call :write_opener

echo    [3/3] Starting Scout ...
echo    Your browser will open in a moment, once the app server is
echo    ready. If it doesn't, double-click "Open Assistant" in this
echo    folder. ^(To stop: just close this window.^)
echo.

set "STICKOS_HOME=%ROOT%"
"%ROOT%\bin\node\node.exe" "%ROOT%\app\server.js"
if errorlevel 1 goto :server_died

echo.
echo    StickOS stopped. Everything stayed on the USB. See you next time!
"%SystemRoot%\System32\timeout.exe" /t 4 >nul
endlocal
exit /b 0


REM ============================================================
REM   SUBROUTINES  (plain lines here, so %VAR% expands normally)
REM ============================================================

:capture_realhome
REM  Remember the real Windows profile before we redirect HOME and
REM  friends onto the stick, so anything that still needs a real
REM  user folder (a browser install, an OS cert store) can find one.
set "REALHOME=%USERPROFILE%"
goto :eof

:redirect_env
REM  Keep everything StickOS touches on the USB stick.
set "HOME=%ROOT%"
set "USERPROFILE=%ROOT%"
set "TMP=%ROOT%\tmp"
set "TEMP=%ROOT%\tmp"
set "TMPDIR=%ROOT%\tmp"
set "XDG_CACHE_HOME=%ROOT%\cache"
set "HF_HOME=%ROOT%\voices\hf-cache"
goto :eof

:make_dirs
for %%D in (tmp cache bin models voices data state chats sessions app) do if not exist "%ROOT%\%%D" mkdir "%ROOT%\%%D" >nul 2>&1
goto :eof

:preflight_write
REM  Some workplace laptops block software from running off a USB
REM  stick on purpose. Find that out now, with a plain explanation,
REM  instead of failing halfway through a download later.
set "PFOK="
(echo test> "%ROOT%\state\write-test.txt") 2>nul
if exist "%ROOT%\state\write-test.txt" set "PFOK=1"
if defined PFOK del /f /q "%ROOT%\state\write-test.txt" >nul 2>&1
goto :eof

:find_node
set "NODE_EXE="
if exist "%ROOT%\bin\node\node.exe" set "NODE_EXE=%ROOT%\bin\node\node.exe"
goto :eof

:get_node
echo    [1/3] First-time setup: getting the Node runtime ^(35 to 50 MB,
echo          usually well under a minute^) ...
if exist "%ROOT%\bin\node-tmp" rmdir /s /q "%ROOT%\bin\node-tmp" >nul 2>&1
mkdir "%ROOT%\bin\node-tmp" >nul 2>&1
call :download "%NODE_URL%" "%ROOT%\bin\node-tmp\%NODE_ZIP_NAME%" 20
if not exist "%ROOT%\bin\node-tmp\%NODE_ZIP_NAME%" goto :eof
call :download "%NODE_SHASUMS%" "%ROOT%\bin\node-tmp\SHASUMS256.txt" 0
call :sha256 "%ROOT%\bin\node-tmp\%NODE_ZIP_NAME%" "%ROOT%\bin\node-tmp\SHASUMS256.txt" "%NODE_ZIP_NAME%"
if defined SHA_OK goto :get_node_extract
echo    !! The Node download did not match its checksum. Removing it
echo       so the next run tries again.
del /f /q "%ROOT%\bin\node-tmp\%NODE_ZIP_NAME%" >nul 2>&1
goto :eof
:get_node_extract
pushd "%ROOT%\bin\node-tmp"
tar -xf "%NODE_ZIP_NAME%"
popd
call :move_node_dir
goto :eof

:move_node_dir
if exist "%ROOT%\bin\node" rmdir /s /q "%ROOT%\bin\node" >nul 2>&1
for /d %%D in ("%ROOT%\bin\node-tmp\node-v*") do move "%%D" "%ROOT%\bin\node" >nul
rmdir /s /q "%ROOT%\bin\node-tmp" >nul 2>&1
goto :eof

:find_app
set "APP_OK="
if exist "%ROOT%\app\server.js" set "APP_OK=1"
goto :eof

:read_app_version
REM  Pulls "app_version" out of settings.json. Kept deliberately
REM  simple: grab the line with findstr, split it on the first
REM  colon, then strip spaces and quotes from what is left. This
REM  only works because settings.json writes one key per line with
REM  a plain quoted string value; build-installer must keep that
REM  shape when it updates app_version.
set "APP_VERSION="
set "AVLINE="
for /f "usebackq tokens=* delims=" %%L in (`findstr /C:"app_version" "%ROOT%\settings.json"`) do if not defined AVLINE set "AVLINE=%%L"
if not defined AVLINE goto :eof
set "AVREST="
for /f "tokens=1,* delims=:" %%A in ("%AVLINE%") do set "AVREST=%%B"
if not defined AVREST goto :eof
set "AVREST=%AVREST: =%"
set "AVREST=%AVREST:"=%"
if "%AVREST:~-1%"=="," set "AVREST=%AVREST:~0,-1%"
set "APP_VERSION=%AVREST%"
goto :eof

:get_app
call :read_app_version
if defined APP_VERSION goto :get_app_url
echo    !! Could not read app_version out of settings.json.
goto :eof
:get_app_url
set "APPURL=https://github.com/Skill-Stacker/claude/releases/download/v%APP_VERSION%/stickos-app-%APP_VERSION%-win-x64.zip"
echo    [2/3] First-time setup: getting the StickOS app ^(version %APP_VERSION%^) ...
if exist "%ROOT%\app-tmp" rmdir /s /q "%ROOT%\app-tmp" >nul 2>&1
mkdir "%ROOT%\app-tmp" >nul 2>&1
call :download "%APPURL%" "%ROOT%\app-tmp\app.zip" 5
if not exist "%ROOT%\app-tmp\app.zip" goto :get_app_fail
pushd "%ROOT%\app-tmp"
tar -xf "app.zip"
popd
if not exist "%ROOT%\app-tmp\app" goto :get_app_fail
if exist "%ROOT%\app" rmdir /s /q "%ROOT%\app" >nul 2>&1
move "%ROOT%\app-tmp\app" "%ROOT%\app" >nul
rmdir /s /q "%ROOT%\app-tmp" >nul 2>&1
call :find_app
goto :eof
:get_app_fail
echo    !! Could not download or unpack the StickOS app.
goto :eof

:find_browser
set "BROWSER="
for %%B in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe") do if not defined BROWSER if exist "%%~B" set "BROWSER=%%~B"
goto :eof

:write_opener
REM  Opening the browser has to happen from a small helper file, not
REM  from a "start" line right here: giving the "start" command a
REM  second quoted argument (its own quoted exe path plus a quoted
REM  argument) launches nothing at all and still exits 0. One quoted
REM  token to "start", pointed at a script that does
REM  the real work, sidesteps that entirely. The helper waits for
REM  state\port.txt (written by the app server once it is actually
REM  listening) instead of guessing a delay, so a slow first run
REM  still ends up opening the assistant.
set "GO=%ROOT%\tmp\open-stickos.cmd"
set "SC=%ROOT%\Open Assistant.url"
if exist "%GO%" del /f /q "%GO%" >nul 2>&1
>"%GO%"  echo @echo off
>>"%GO%" echo set N=0
>>"%GO%" echo :wait
>>"%GO%" echo if exist "%ROOT%\state\port.txt" goto go
>>"%GO%" echo set /a N+=1
>>"%GO%" echo if %%N%% GTR 600 goto :eof
>>"%GO%" echo "%SystemRoot%\System32\timeout.exe" /t 1 /nobreak ^>nul
>>"%GO%" echo goto wait
>>"%GO%" echo :go
>>"%GO%" echo set /p PORT=^<"%ROOT%\state\port.txt"
>>"%GO%" echo ^>"%SC%" echo [InternetShortcut]
>>"%GO%" echo ^>^>"%SC%" echo URL=http://127.0.0.1:%%PORT%%/
>>"%GO%" echo ^>^>"%SC%" echo IconIndex=0
if defined BROWSER (
>>"%GO%" echo "%BROWSER%" "--app=http://127.0.0.1:%%PORT%%/" "--user-data-dir=%ROOT%\cache\browser"
) else (
>>"%GO%" echo start "" http://127.0.0.1:%%PORT%%/
)
start "" /min cmd /c "%GO%"
goto :eof

:download
REM  %1 = url   %2 = destination file   %3 = smallest believable size in MB
set "DL_URL=%~1"
set "DL_OUT=%~2"
set "DL_MIN=%~3"
call :prune "%DL_OUT%" "%DL_MIN%"
if exist "%DL_OUT%" goto :eof
where curl.exe >nul 2>&1
if errorlevel 1 goto :download_ps
curl.exe -L -C - --fail --retry 3 --progress-bar -o "%DL_OUT%" "%DL_URL%"
goto :download_verify
:download_ps
powershell -NoProfile -Command "try{Invoke-WebRequest -Uri $env:DL_URL -OutFile $env:DL_OUT -UseBasicParsing}catch{Write-Host ('   download failed: ' + $_.Exception.Message)}"
:download_verify
call :prune "%DL_OUT%" "%DL_MIN%"
goto :eof

:prune
REM  delete %1 if it is smaller than %2 MB (a truncated file or an
REM  error page saved with the right name and the wrong contents)
set "PR_FILE=%~1"
set "PR_MIN=%~2"
if not exist "%PR_FILE%" goto :eof
powershell -NoProfile -Command "$p=$env:PR_FILE; if((Get-Item -LiteralPath $p).Length -lt ([int64]$env:PR_MIN * 1MB)){Remove-Item -LiteralPath $p -Force}"
goto :eof

:sha256
REM  %1 = file to verify   %2 = SHASUMS256.txt path   %3 = filename
REM  to look up in that list. Sets SHA_OK when they match. certutil
REM  prints the hash bytes space separated, so those spaces have to
REM  come out before comparing it against the plain hex in the list.
set "SHA_OK="
set "SHA_FILE=%~1"
set "SHA_LIST=%~2"
set "SHA_NAME=%~3"
if not exist "%SHA_FILE%" goto :eof
if not exist "%SHA_LIST%" goto :eof
set "EXPECTED="
for /f "tokens=1" %%H in ('findstr /C:"%SHA_NAME%" "%SHA_LIST%"') do if not defined EXPECTED set "EXPECTED=%%H"
if not defined EXPECTED goto :eof
set "ACTUAL="
for /f "skip=1 delims=" %%A in ('certutil -hashfile "%SHA_FILE%" SHA256') do if not defined ACTUAL set "ACTUAL=%%A"
if not defined ACTUAL goto :eof
set "ACTUAL=%ACTUAL: =%"
if /i "%ACTUAL%"=="%EXPECTED%" set "SHA_OK=1"
goto :eof


:no_write
echo.
echo    !! This folder cannot be written to.
echo       StickOS needs a personal, unmanaged computer to run from a
echo       USB stick. Many workplace laptops block software on USB
echo       sticks on purpose, and there is no way around that from
echo       here. Try a personal computer instead.
echo.
pause
exit /b 1

:node_missing
echo.
echo    !! Could not get the Node runtime automatically.
echo       Check your internet connection and run Start Button again.
echo.
pause
exit /b 1

:app_missing
echo.
echo    !! Could not get the StickOS app automatically.
echo       Check your internet connection and run Start Button again.
echo.
pause
exit /b 1

:server_died
echo.
echo    !! StickOS stopped with an error.
echo       A permission window may have opened behind this one, or
echo       security software may have quietly removed a file. Run
echo       Start Button again; anything that was removed is fetched
echo       again automatically.
echo.
pause
exit /b 1
