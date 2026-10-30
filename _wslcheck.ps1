Write-Output "=== EnableLUA ==="
(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableLUA -ErrorAction SilentlyContinue).EnableLUA
Write-Output "=== LimitBlankPasswordUse ==="
(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa' -Name LimitBlankPasswordUse -ErrorAction SilentlyContinue).LimitBlankPasswordUse
Write-Output "=== IsAdmin ==="
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Output "=== Identity ==="
[Security.Principal.WindowsIdentity]::GetCurrent().Name
Write-Output "=== WSL events ==="
Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=(Get-Date).AddHours(-2)} -MaxEvents 300 -ErrorAction SilentlyContinue |
  Where-Object { $_.Message -match 'WSL|Lxss|80070569' } |
  Select-Object -First 3 TimeCreated, ProviderName, Message | Format-List
