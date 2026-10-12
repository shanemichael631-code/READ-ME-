@echo off
rem Nova Hub desktop shortcut. Put this file in the same folder as hub.html and nova-hub.ico
rem (usually Downloads), then double-click it. It copies both files to Documents\Nova Hub
rem and puts a "Nova Hub" shortcut with the Nova icon on your desktop.
title Nova Hub shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $src='%~dp0'; if(!(Test-Path (Join-Path $src 'hub.html'))){ Write-Host ''; Write-Host 'hub.html is not in this folder. Put this file next to hub.html and nova-hub.ico, then run it again.'; exit 1 }; $dest=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Nova Hub'; New-Item -ItemType Directory -Force -Path $dest | Out-Null; Copy-Item (Join-Path $src 'hub.html') $dest -Force; $ico=Join-Path $src 'nova-hub.ico'; if(Test-Path $ico){ Copy-Item $ico $dest -Force }; $desk=[Environment]::GetFolderPath('Desktop'); $w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut((Join-Path $desk 'Nova Hub.lnk')); $s.TargetPath=(Join-Path $dest 'hub.html'); $s.WorkingDirectory=$dest; if(Test-Path (Join-Path $dest 'nova-hub.ico')){ $s.IconLocation=((Join-Path $dest 'nova-hub.ico')+',0') }; $s.Description='Nova Hub'; $s.Save(); Write-Host ''; Write-Host ('Done. Nova Hub is on your desktop. The files live in ' + $dest) }"
echo.
pause
