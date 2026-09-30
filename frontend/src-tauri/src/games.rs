//! 进程检测与退出游戏 —— **前端自己做**。
//!
//! 枚举进程、`TerminateProcess` 都不需要提权，所以这两件事不经过启动器：启动器没运行
//! 也能用（FRONTEND.md §3 的决定）。候选表来自启动器发布的 `library.json`
//! （`library_read`），匹配逻辑与启动器共用 `fh_core::process`，不会两边走偏。

use fh_core::process::RunningQuery;

#[tauri::command]
pub async fn running_games(items: Vec<RunningQuery>) -> Vec<String> {
    crate::off_main(move || fh_core::process::running_ids(&items))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn quit_game(
    id: String,
    launch_path: String,
    install_path: String,
) -> Result<u32, String> {
    // id 只为和启动器的命令签名保持一致（前端不记「谁启动的」，用不上它）。
    let _ = &id;
    let killed =
        crate::off_main(move || fh_core::process::kill_game(&launch_path, &install_path)).await?;
    if killed == 0 {
        // 界面靠这两句话判断「本来就没在跑」，措辞与启动器一致。
        return Err(fh_core::i18n::pick(
            "没有找到正在运行的游戏进程",
            "No running process was found for that game.",
        ));
    }
    Ok(killed)
}
