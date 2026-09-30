; 独立前端的 NSIS 安装钩子。
;
; 装完就让它开机自启 —— 托盘常驻本来就是这个程序的用法。这里调它**自己**的开关
; （`--enable-autostart`）而不是直接写注册表：这样注册表里的值与托盘菜单里那个勾选项
; 必然一致（同一个插件写同一个值名）。
;
; 卸载交给前端自己的卸载器：Tauri 生成的 NSIS 卸载流程本来就会处理"自己的程序还在跑"，
; 不需要启动器那边额外动手（启动器卸载时也不会去杀它）。

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Enabling FantasyHub frontend autostart"
  Exec '"$INSTDIR\FantasyHubFrontend.exe" --enable-autostart'
!macroend
