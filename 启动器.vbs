' edge-todo launcher: start the app without any console window.
' Double-click me after "npm install". Safe to run twice (single-instance).
Option Explicit
Dim fso, sh, base, exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
exe = base & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  MsgBox "Electron runtime not found." & vbCrLf & vbCrLf & _
         "Please run [npm install] in this folder first:" & vbCrLf & base, _
         48, "edge-todo"
  WScript.Quit 1
End If
sh.CurrentDirectory = base
sh.Run """" & exe & """ """ & base & """", 1, False
