@echo off
title Lancement du partage d'ecran
color 0A

REM ============================================
REM  Le token et le domaine ngrok sont lus
REM  depuis le fichier .env (ne pas les mettre ici)
REM ============================================
if not exist "%~dp0.env" (
    echo ERREUR : fichier .env introuvable.
    echo Copie .env.example en .env et renseigne tes valeurs.
    pause
    exit /b 1
)
for /f "usebackq tokens=1,2 delims==" %%A in ("%~dp0.env") do (
    if "%%A"=="BROADCASTER_TOKEN" set TOKEN=%%B
    if "%%A"=="NGROK_DOMAIN" set NGROK_DOMAIN=%%B
)

echo ================================================
echo   Demarrage du serveur Node.js...
echo ================================================
start "Serveur Node" cmd /k "cd /d %~dp0 && node server.js"

REM On attend 3 secondes que le serveur soit bien lance
timeout /t 3 /nobreak >nul

echo ================================================
echo   Demarrage de ngrok...
echo ================================================
start "ngrok" cmd /k "ngrok http 3000 --url=%NGROK_DOMAIN%"

REM On attend 4 secondes que ngrok etablisse le tunnel
timeout /t 4 /nobreak >nul

echo ================================================
echo   Ouverture de la page emetteur dans Edge
echo ================================================
set EDGE_PATH="%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist %EDGE_PATH% set EDGE_PATH="%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if exist %EDGE_PATH% (
    start "" %EDGE_PATH% --new-window "https://%NGROK_DOMAIN%/sender?token=%TOKEN%"
) else (
    echo Edge introuvable au chemin habituel, tentative via l'alias "msedge"...
    start "" msedge --new-window "https://%NGROK_DOMAIN%/sender?token=%TOKEN%"
)

echo.
echo ================================================
echo   Tout est lance !
echo   Lien a envoyer aux spectateurs :
echo   https://%NGROK_DOMAIN%/watch/room1
echo ================================================
echo.
echo Cette fenetre peut etre fermee.
pause
