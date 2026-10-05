; 启动器的 NSIS 安装钩子（Tauri 2 的 bundle.windows.nsis.installerHooks）。
;
; 小组件（Game Bar 小组件 + 随包的 WinRing0 驱动）已从本仓库移除，这里不再需要做任何事。
; 但**两个宏必须留着**：Tauri 的 NSIS 模板会插入它们，缺一个就是编译期报错
; （虽然模板里包了 !ifmacrodef，保留空宏能顺带兼容不检查宏存在的版本）。
; 也顺手把旧版本留下的东西清掉 —— 见过 0.1.61 之前版本的用户机器上可能还有
; 注册过的 Win+G 小组件，卸载后点不开会很难解释。

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  SetShellVarContext current
  ; 旧版的 Game Bar 小组件（FantasyHub.GameBar）如果还在，升级时清掉：
  ; 现在的安装包已经不带小组件了，留着它只会在 Win+G 里显示一个打不开的壳。
  ExecWait "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $\"Get-AppxPackage -Name FantasyHub.GameBar | Remove-AppxPackage -ErrorAction SilentlyContinue$\"" $1
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Push $0
  Push $1
  SetShellVarContext current
  ; 同 POSTINSTALL：老版本装过的小组件要跟着卸载一起走。
  ; 用 PREUNINSTALL 是因为那时 $INSTDIR 还在（这条命令其实不依赖文件）。
  ExecWait "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $\"Get-AppxPackage -Name FantasyHub.GameBar | Remove-AppxPackage -ErrorAction SilentlyContinue$\"" $1
  Pop $1
  Pop $0
!macroend

