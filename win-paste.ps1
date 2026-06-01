# Хелпер вставки.
#  -Capture       → вивести HWND активного вікна (на keydown F9, поки фокус на цілі)
#  -Hwnd <число>  → повернути фокус на це вікно і надіслати Ctrl+V (на paste)
# Безпечна активація: лише AttachThreadInput + SetForegroundWindow,
# БЕЗ ShowWindow/BringWindowToTop (щоб не чіпати розмір/видимість чужих вікон).
param(
  [long]$Hwnd = 0,
  [switch]$Capture
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  public static void Activate(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return;
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint cur = GetCurrentThreadId();
    if (fg != cur) AttachThreadInput(fg, cur, true);
    SetForegroundWindow(hWnd);
    if (fg != cur) AttachThreadInput(fg, cur, false);
  }
}
"@

if ($Capture) {
  [FG]::GetForegroundWindow().ToInt64()
} else {
  if ($Hwnd -ne 0) {
    [FG]::Activate([IntPtr]$Hwnd)
    Start-Sleep -Milliseconds 60
  }
  $w = New-Object -ComObject WScript.Shell
  $w.SendKeys('^v')
}
