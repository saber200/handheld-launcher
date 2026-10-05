; 启动器的 NSIS 安装钩子（Tauri 2 的 bundle.windows.nsis.installerHooks）。
;
; 这里只做一件事：随启动器把 **Game Bar 小组件**（前端界面就是它）注册到当前用户（Win+G 里那个）。

!macro NSIS_HOOK_POSTINSTALL
  ; 模板可能正在用 $0/$1，用完记得还原（NSIS 的寄存器没有"保存"约定）。
  Push $0
  Push $1
  SetShellVarContext current

  ; Game Bar 小组件：包里带的是「签好名的 msix + 它的签名证书 + 三个框架依赖」。
  ; 为什么这里是手写的一行而不是调用随包的 register-widget.ps1：那需要把脚本当资源再发一份、
  ; 还要处理安装目录里的脚本编码（PS 5.1 读没有 BOM 的 UTF-8 会乱码）和提权上下文，
  ; 风险比这一行大得多。这一行只求「装完立刻能在 Win+G 里看到」：
  ; 信任证书（当前用户，不需要管理员）→ 装三个框架依赖（已装的会报错，忽略）→ 装小组件 → 重启 Game Bar。
  ; 完整逻辑（按 hash 比对、清掉旧证书、失败分类）在启动器里：它每次启动都会再跑一遍并补上，
  ; 所以这里失败也不算数 —— 返回码只打进日志，不阻塞安装。
  ; 注意：这一行不写 hash 标记，因此启动器第一次启动会再核对/重装一次，之后就幂等了。
  IfFileExists "$INSTDIR\payload\gamebar\widget.msix" fh_widget 0
  Goto fh_widget_done
  fh_widget:
    DetailPrint "Registering the FantasyHub Game Bar widget"
    ; 引号规则：整条命令用双引号包，PowerShell 自己那段用 $\" 转义，路径用 PowerShell 的单引号
    ; —— NSIS 的单引号字符串里没法用 ' 转义（只能 $\'），混起来很容易编译不过。
    ExecWait "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $\"Import-Certificate -FilePath '$INSTDIR\payload\gamebar\widget.cer' -CertStoreLocation Cert:\CurrentUser\TrustedPeople | Out-Null; Add-AppxPackage -Path '$INSTDIR\payload\gamebar\deps\Microsoft.NET.CoreRuntime.2.2.appx' -ErrorAction SilentlyContinue; Add-AppxPackage -Path '$INSTDIR\payload\gamebar\deps\Microsoft.NET.CoreFramework.Debug.2.2.appx' -ErrorAction SilentlyContinue; Add-AppxPackage -Path '$INSTDIR\payload\gamebar\deps\Microsoft.VCLibs.x64.Debug.14.00.appx' -ErrorAction SilentlyContinue; Add-AppxPackage -Path '$INSTDIR\payload\gamebar\widget.msix'; Get-Process GameBar,GameBarFTServer -ErrorAction SilentlyContinue | Stop-Process -Force$\"" $1
    DetailPrint "Game Bar widget registration exit code: $1"
  fh_widget_done:
  Pop $1
  Pop $0
!macroend

; 卸载要把小组件一起清掉，否则「已卸载」的启动器会在 Game Bar 里留一个点不开的小组件。
; 用 PREUNINSTALL：那时文件还在（POSTUNINSTALL 时 $INSTDIR 已经空了），虽然这条命令其实不依赖文件。
; 依赖的框架包不动（微软的，别的应用可能也在用），证书也不动（同主题的还有 FSE 身份证书）。
!macro NSIS_HOOK_PREUNINSTALL
  Push $0
  Push $1
  SetShellVarContext current
  DetailPrint "Removing the FantasyHub Game Bar widget"
  ExecWait "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $\"Get-AppxPackage -Name FantasyHub.GameBar | Remove-AppxPackage; Get-Process GameBar,GameBarFTServer -ErrorAction SilentlyContinue | Stop-Process -Force$\"" $1
  DetailPrint "Game Bar widget removal exit code: $1"
  Pop $1
  Pop $0
!macroend

