@echo off
REM ---------------------------------------------------------------------------
REM  Atalho do Gideao para Windows.
REM
REM  Clique duas vezes e ele sobe. A janela precisa ficar aberta: e o processo
REM  dele rodando. Fechar a janela e desligar o Gideao.
REM
REM  O navegador abre sozinho, ja com o token de acesso.
REM ---------------------------------------------------------------------------
cd /d "%~dp0"
title Gideao
echo.
echo   Subindo o Gideao...
echo   Nao feche esta janela enquanto estiver usando.
echo.
call npm start
echo.
echo   O Gideao foi encerrado. Pode fechar esta janela.
pause
