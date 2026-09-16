# ---------------------------------------------------------------------------
#  Cria um atalho do Gideão na área de trabalho.
#
#  Rode uma vez: .\criar-atalho.ps1
#  Depois é só clicar duas vezes no atalho, sem terminal nenhum.
# ---------------------------------------------------------------------------
$projeto  = $PSScriptRoot
$atalho   = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Gideão.lnk'

$shell = New-Object -ComObject WScript.Shell
$link  = $shell.CreateShortcut($atalho)
$link.TargetPath       = Join-Path $projeto 'gideao.cmd'
$link.WorkingDirectory = $projeto
$link.Description      = 'Assistente pessoal Gideão'
$link.IconLocation     = "$env:SystemRoot\System32\shell32.dll,14"
$link.Save()

Write-Host ""
Write-Host "  Pronto. O atalho 'Gideão' está na sua área de trabalho." -ForegroundColor Green
Write-Host "  Clique duas vezes nele para ligar. A senha-mestra é pedida na janela preta."
Write-Host ""
