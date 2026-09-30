; 启动器的 NSIS 安装钩子（Tauri 2 的 bundle.windows.nsis.installerHooks）。
;
; 这里只做一件事：随启动器把**独立前端**装上/更新（前端是另一个程序、有自己的安装包，
; 见仓库根 FRONTEND.md）。启动器不控制前端，所以这里也不出现任何启动/结束它的调用。
;
; 覆盖安装前要先请正在运行的前端退出：它的 exe 被自己占用着，安装包覆盖不了。
; 握手用标记文件（crates/fh-core/src/handshake.rs 里有完整说明）—— 前端每 2 秒看一眼，
; 看到就真正退出进程；这里等 6 秒再装，没在跑就白等这一会儿，用户无感。

!macro NSIS_HOOK_POSTINSTALL
  ; 模板可能正在用 $0/$1，用完记得还原（NSIS 的寄存器没有"保存"约定）。
  Push $0
  Push $1
  SetShellVarContext current
  IfFileExists "$INSTDIR\payload\frontend-setup.exe" fh_frontend_payload 0
  Goto fh_frontend_done
  fh_frontend_payload:
    CreateDirectory "$APPDATA\handheld-launcher"
    FileOpen $0 "$APPDATA\handheld-launcher\quit-for-update" w
    FileWrite $0 "quit-for-update$\r$\n"
    FileClose $0
    DetailPrint "Asking a running FantasyHub frontend to quit for the update"
    Sleep 6000
    DetailPrint "Installing the standalone FantasyHub frontend"
    ExecWait '"$INSTDIR\payload\frontend-setup.exe" /S' $1
    DetailPrint "Frontend installer exit code: $1"
    Delete "$APPDATA\handheld-launcher\quit-for-update"
  fh_frontend_done:
  Pop $1
  Pop $0
!macroend
