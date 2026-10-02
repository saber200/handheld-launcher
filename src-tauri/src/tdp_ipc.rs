//! 只暴露 TDP 的本地 IPC 服务端（协议与客户端在 `fh_core::ipc`）。
//!
//! 为什么需要它：TDP 要读写 MSR，只有提权且装了 WinRing0 的启动器能做；让前端自己提权
//! 会在每次开机弹 UAC，托盘常驻软件不能这么干（FRONTEND.md §4）。所以前端只管发请求，
//! 实际动作在这里。暴露的能力只有：读 TDP 状态、写 TDP 瓦数、读驱动状态 —— 没有任何
//! 窗口或进程控制，前端开关浮层完全不经过启动器。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

const MAX_REQUEST: u64 = 4096;
const MAX_CLIENTS: usize = 4;
const TIMEOUT: Duration = Duration::from_millis(1500);

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
    let token = ipc::random_token()?;
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

    // Bound concurrent clients so an idle/slow peer cannot stall all TDP requests.
    let active = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                if active.fetch_add(1, Ordering::AcqRel) >= MAX_CLIENTS {
                    active.fetch_sub(1, Ordering::AcqRel);
                    continue;
                }
                let active = Arc::clone(&active);
                let token = token.clone();
                std::thread::spawn(move || {
                    handle(stream, &token);
                    active.fetch_sub(1, Ordering::AcqRel);
                });
            }
            Err(err) => crate::logutil::write_line(&format!("tdp ipc accept failed: {err}")),
        }
    }
    ipc::clear_discovery_if_pid(std::process::id());
    Ok(())
}

fn handle(mut stream: TcpStream, token: &str) {
    let _ = stream.set_read_timeout(Some(TIMEOUT));
    let _ = stream.set_write_timeout(Some(TIMEOUT));
    let Ok(bytes) = read_request(&mut stream) else { return };
    let Ok(line) = std::str::from_utf8(&bytes) else { return };
    let response = match ipc::parse_request(line, token) {
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

// A per-read timeout is not a total deadline: a slow sender must not hold
// a privileged worker indefinitely.
fn read_request(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let deadline = std::time::Instant::now() + TIMEOUT;
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        stream.set_read_timeout(Some(remaining))?;
        let limit = chunk.len().min((MAX_REQUEST + 1 - bytes.len() as u64) as usize);
        let count = stream.read(&mut chunk[..limit])?;
        if count == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() as u64 > MAX_REQUEST {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        if let Some(end) = bytes.iter().position(|&byte| byte == b'\n') {
            if end + 1 != bytes.len() {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            return Ok(bytes);
        }
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

#[cfg(test)]
mod tests {
    use super::{read_request, MAX_REQUEST};
    use std::io::Write;
    use std::net::{TcpListener, TcpStream};
    use std::time::{Duration, Instant};

    fn with_client(send: impl FnOnce(&mut TcpStream)) -> std::io::Result<Vec<u8>> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        send(&mut client);
        read_request(&mut server)
    }

    #[test]
    fn accepts_one_line_and_rejects_incomplete_or_oversized() {
        assert_eq!(with_client(|client| client.write_all(b"{}\n").unwrap()).unwrap(), b"{}\n");
        assert!(with_client(|client| { client.write_all(b"{}").unwrap(); client.shutdown(std::net::Shutdown::Write).unwrap(); }).is_err());
        assert!(with_client(|client| client.write_all(&vec![b'a'; MAX_REQUEST as usize + 1]).unwrap()).is_err());
    }

    #[test]
    fn idle_client_times_out() {
        let started = Instant::now();
        assert!(with_client(|_| {}).is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
