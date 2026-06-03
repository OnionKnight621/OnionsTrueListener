# Paste helper.
#  -Capture       -> print "HWND|Title" of the active window (on key-down, while it has focus)
#  -Hwnd <number> -> activate that window and send Ctrl+V (on paste)
# Activation: alt-hack (releases the foreground lock) + AttachThreadInput +
# SetForegroundWindow. Keystrokes are sent via keybd_event.
param(
  [long]$Hwnd = 0,
  [switch]$Capture
)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);

  const byte VK_MENU = 0x12;    // Alt
  const byte VK_CONTROL = 0x11;
  const byte VK_V = 0x56;
  const uint KEYUP = 0x2;

  public static string Title(IntPtr h) {
    var sb = new StringBuilder(256);
    GetWindowText(h, sb, 256);
    return sb.ToString();
  }

  public static void Activate(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return;
    // Already focused (dictating straight into it) -> don't touch focus:
    // in Chrome the alt-hack shifts focus to the browser menu and loses the input field.
    if (GetForegroundWindow() == hWnd) return;
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint cur = GetCurrentThreadId();
    // alt-hack: a quick Alt tap lets our process change the foreground window.
    keybd_event(VK_MENU, 0, 0, IntPtr.Zero);
    keybd_event(VK_MENU, 0, KEYUP, IntPtr.Zero);
    if (fg != cur) AttachThreadInput(fg, cur, true);
    SetForegroundWindow(hWnd);
    if (fg != cur) AttachThreadInput(fg, cur, false);
  }

  public static void CtrlV() {
    keybd_event(VK_CONTROL, 0, 0, IntPtr.Zero);
    keybd_event(VK_V, 0, 0, IntPtr.Zero);
    keybd_event(VK_V, 0, KEYUP, IntPtr.Zero);
    keybd_event(VK_CONTROL, 0, KEYUP, IntPtr.Zero);
  }
}
"@

if ($Capture) {
  $h = [FG]::GetForegroundWindow()
  "$($h.ToInt64())|$([FG]::Title($h))"
} else {
  if ($Hwnd -ne 0) {
    [FG]::Activate([IntPtr]$Hwnd)
    Start-Sleep -Milliseconds 80
  }
  [FG]::CtrlV()
}
