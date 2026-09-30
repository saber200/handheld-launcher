fn main() {
    // 独立前端不挂 app manifest（不加管理员权限）。
    tauri_build::build()
}
