Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
bat = fso.GetParentFolderName(WScript.ScriptFullName) & "\run-travel-time.bat"
WshShell.Run "cmd /c """ & bat & """", 0, False
