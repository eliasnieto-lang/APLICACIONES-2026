@echo off
setlocal
cd /d "%~dp0"
title Detener Circulos 2027
docker compose stop
if errorlevel 1 (
  echo No se pudo detener la aplicacion. Comprueba que Docker Desktop este abierto.
  pause
  exit /b 1
)
echo Aplicacion detenida. Los estudiantes y los PDF siguen guardados.
pause
