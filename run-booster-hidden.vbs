' Starts the Agony Values booster with no window (used at Windows login).
' To stop it: Task Manager > Details > end "node.exe" (the one running booster.mjs), or restart the PC.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "cmd /c """"" & dir & "\start-booster.bat"" hidden""", 0, False
