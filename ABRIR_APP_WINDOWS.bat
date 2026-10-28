@echo off
setlocal
cd /d "%~dp0"
if not defined CIRCULOS_PORT set "CIRCULOS_PORT=3001"
title Circulos 2027 - Colegio Albert Einstein
echo.
echo   CIRCULOS DE ESTUDIOS 2027
echo   Colegio Albert Einstein
echo.
echo Este archivo inicia la aplicacion en TU computadora.
echo La primera vez se descargan sus componentes. Puede tardar varios minutos.
echo.
where docker >nul 2>nul
if errorlevel 1 (
  echo Primero instala Docker Desktop desde su sitio oficial:
  echo https://docs.docker.com/desktop/setup/install/windows-install/
  echo Abre Docker Desktop y vuelve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop no esta listo. Abre Docker Desktop y espera a que termine de iniciar.
  echo Despues vuelve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)
docker compose version >nul 2>nul
if errorlevel 1 (
  echo Actualiza Docker Desktop: se necesita Docker Compose V2.
  pause
  exit /b 1
)
docker compose up --detach --build --wait --wait-timeout 180
if errorlevel 1 (
  echo.
  echo No se pudo iniciar la aplicacion. Conserva el mensaje anterior para revisar el problema.
  echo Comprueba tu conexion y que el puerto %CIRCULOS_PORT% no este ocupado.
  echo NO borres los volumenes de Docker: contienen los estudiantes y las libretas.
  pause
  exit /b 1
)
echo.
echo La aplicacion esta lista. Se abrira tu navegador.
echo Tus datos quedan guardados en el volumen persistente de Docker.
echo Para detenerla, usa DETENER_APP_WINDOWS.bat. Cerrar el navegador no borra los datos.
start "" "http://127.0.0.1:%CIRCULOS_PORT%"
exit /b 0
