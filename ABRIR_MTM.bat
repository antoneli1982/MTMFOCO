@echo off
title MTM EM FOCO - Iniciando...
color 0A
echo.
echo  ==========================================
echo   MTM EM FOCO - Abrindo ferramenta...
echo  ==========================================
echo.

REM Tenta Python 3
python --version >nul 2>&1
if %errorlevel% == 0 (
    echo  Servidor iniciado! Abrindo navegador...
    start http://localhost:8080
    python -m http.server 8080
    goto :fim
)

REM Tenta py (alias do Python no Windows)
py --version >nul 2>&1
if %errorlevel% == 0 (
    echo  Servidor iniciado! Abrindo navegador...
    start http://localhost:8080
    py -m http.server 8080
    goto :fim
)

REM Tenta Node.js
node --version >nul 2>&1
if %errorlevel% == 0 (
    echo  Usando Node.js...
    start http://localhost:8080
    npx http-server -p 8080 -o
    goto :fim
)

REM Nenhum encontrado
echo.
echo  ERRO: Python ou Node.js nao encontrado.
echo.
echo  Instale o Python gratuitamente em:
echo  https://www.python.org/downloads/
echo.
echo  Depois clique duas vezes neste arquivo novamente.
echo.
pause
:fim
