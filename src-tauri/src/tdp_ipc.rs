//! 只暴露 TDP 的本地 IPC 服务端（协议与客户端在 `fh_core::ipc`）。
//!
//! 为什么需要它：TDP 要读写 MSR，只有提权且装了 WinRing0 的启动器能做；让前端自己提权
//! 会在每次开机弹 UAC，托盘常驻软件不能这么干（FRONTEND.md §4）。所以前端只管发请求，
//! 实际动作在这里。暴露的能力只有：读 TDP 状态、写 TDP 瓦数、读驱动状态 —— 没有任何
//! 窗口或进程控制，前端开关浮层完全不经过启动器。

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};

use fh_core::ipc::{self, Discovery, Request, Response};

/// 起一个后台线程监听回环端口，并把端口/token 公布到 `tdp-ipc.json`。
pub fn start() {
    std::thread::spawn(move || {
        if let Err(err) = serve() {
            crate::logutil::write_line(&format!("tdp ipc stopped: {err}"));
        }
    });
}

fn serve() -> Result<(), String> {
    // 端口 0 = 让系统分配空闲端口：不占固定号，也不用担心被别的程序先占。
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|err| err.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|err| err.to_string())?
        .port();
    let token = ipc::random_token();
    ipc::write_discovery(&Discovery {
        proto: ipc::PROTO,
        port,
        token: token.clone(),
        pid: std::process::id(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })?;
    crate::logutil::write_line(&format!(
        "tdp ipc listening 127.0.0.1:{port} proto={}",
        ipc::PROTO
    ));

    // 一问一答、串行处理：请求很轻（读/写一次 MSR），不值得为它上连接池。
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => handle(stream, &token),
            Err(err) => crate::logutil::write_line(&format!("tdp ipc accept failed: {err}")),
        }
    }
    ipc::clear_discovery();
    Ok(())
}

fn handle(mut stream: TcpStream, token: &str) {
    let reader = match stream.try_clone() {
        Ok(reader) => reader,
        Err(_) => return,
    };
    let mut line = String::new();
    if BufReader::new(reader).read_line(&mut line).is_err() {
        return;
    }
    let response = match ipc::parse_request(&line, token) {
        Ok(request) => dispatch(request),
        Err(err) => {
            crate::logutil::write_line(&format!("tdp ipc rejected: {err}"));
            Response::err(0, err)
        }
    };
    if let Ok(body) = serde_json::to_string(&response) {
        let _ = stream.write_all(format!("{body}\n").as_bytes());
        let _ = stream.flush();
    }
}

fn dispatch(request: Request) -> Response {
    let id = request.id;
    let outcome: Result<serde_json::Value, String> = match request.cmd.as_str() {
        ipc::CMD_TDP_STATUS => {
            let info = tauri::async_runtime::block_on(crate::tdp::tdp_status());
            serde_json::to_value(info).map_err(|err| err.to_string())
        }
        ipc::CMD_SET_TDP => match request.watts {
            Some(watts) => match tauri::async_runtime::block_on(crate::tdp::set_tdp(watts)) {
                Ok(info) => serde_json::to_value(info).map_err(|err| err.to_string()),
                Err(err) => Err(err),
            },
            None => Err("set_tdp 缺少 watts".to_string()),
        },
        ipc::CMD_TDP_DRIVER_STATUS => {
            let status = tauri::async_runtime::block_on(crate::toolbox::toolbox_tdp_driver_status());
            serde_json::to_value(status).map_err(|err| err.to_string())
        }
        // 只认这三件事：别的命令明确拒绝，也就不会出现「顺手把前端也控制了」。
        other => Err(format!("不支持的命令：{other}")),
    };
    match outcome {
        Ok(data) => Response::ok(id, data),
        Err(error) => {
            crate::logutil::write_line(&format!("tdp ipc id={id} failed: {error}"));
            Response::err(id, error)
        }
    }
}
