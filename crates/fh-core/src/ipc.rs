//! 启动器 ↔ 独立前端之间的本地 IPC —— **只为一件事：TDP**。
//!
//! ## 为什么是回环 TCP，而不是命名管道
//!
//! 启动器是提权进程（`requireAdministrator`，TDP 要 WinRing0）。提权进程创建的命名管道
//! 默认带高完整性级别标签，未提权的前端**写不进去**（MIC 的 no-write-up），除非自己写
//! SDDL 放宽 —— 那是最容易在真机上静默失败、又最难远程排查的写法。127.0.0.1 回环 socket
//! 不受完整性级别限制，纯 std、无 unsafe。代价是必须自己守好门口：随机端口 + 一次性 token。
//!
//! ## 发现方式
//!
//! 启动器启动时监听 `127.0.0.1:0`（随机端口），把端口与 token 写到
//! `%APPDATA%\handheld-launcher\tdp-ipc.json`；前端读这个文件再连。
//! 两个进程都写同一个日志文件，出问题可以对着时间线看。
//!
//! ## 协议
//!
//! 一行一个 JSON，一问一答（一次连接一个请求，够用且不容易错）：
//!
//! ```text
//! 请求  {"proto":1,"token":"…","id":1,"cmd":"tdp_status"}
//! 请求  {"proto":1,"token":"…","id":2,"cmd":"set_tdp","watts":15}
//! 响应  {"id":1,"ok":true,"data":{…}}
//! 响应  {"id":1,"ok":false,"error":"…"}
//! ```
//!
//! 暴露的能力只有三个：读 TDP 状态、写 TDP 瓦数、读驱动状态。**没有任何窗口或进程控制**，
//! 所以即使 token 泄露，别人最多也就能调个功耗。

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 协议版本。前端拿到不一致的版本就提示“启动器版本不匹配”，不静默失败。
pub const PROTO: u32 = 1;

pub const CMD_TDP_STATUS: &str = "tdp_status";
pub const CMD_SET_TDP: &str = "set_tdp";
pub const CMD_TDP_DRIVER_STATUS: &str = "tdp_driver_status";

/// 连接与读写都很快就该有结果：慢过这个时间当作“启动器没运行”。
const IO_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub proto: u32,
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    #[serde(default = "default_proto")]
    pub proto: u32,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub id: u64,
    pub cmd: String,
    #[serde(default)]
    pub watts: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    #[serde(default)]
    pub id: u64,
    pub ok: bool,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
}

fn default_proto() -> u32 {
    PROTO
}

impl Response {
    pub fn ok(id: u64, data: serde_json::Value) -> Self {
        Self {
            id,
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(id: u64, error: impl Into<String>) -> Self {
        Self {
            id,
            ok: false,
            data: None,
            error: Some(error.into()),
        }
    }
}

pub fn discovery_path() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata)
                .join("handheld-launcher")
                .join("tdp-ipc.json");
        }
    }
    std::env::temp_dir().join("fantasyhub-tdp-ipc.json")
}

/// 启动器侧：把端口与 token 公布出去（原子写，避免前端读到半截 JSON）。
pub fn write_discovery(info: &Discovery) -> Result<(), String> {
    let path = discovery_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let body = serde_json::to_string(info).map_err(|err| err.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|err| err.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|err| err.to_string())
}

/// 启动器退出时收掉公布文件，免得前端一直去连一个没人听的端口。
pub fn clear_discovery() {
    let _ = std::fs::remove_file(discovery_path());
}

pub fn read_discovery() -> Result<Discovery, String> {
    let path = discovery_path();
    let body = std::fs::read_to_string(&path).map_err(|_| "启动器还没起来".to_string())?;
    serde_json::from_str(&body).map_err(|err| err.to_string())
}

/// 32 位十六进制的随机 token。
///
/// `RandomState` 的哈希键取自操作系统的随机数，拿它凑出 16 字节，足够防“随便一个本地
/// 进程就能调功耗”，也省掉一个 rand 依赖。
pub fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut out = String::with_capacity(32);
    while out.len() < 32 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(std::process::id() as u64 ^ out.len() as u64);
        hasher.write_u64(0x9e37_79b9_7f4a_7c15);
        let value = hasher.finish();
        out.push_str(&format!("{value:016x}"));
    }
    out.truncate(32);
    out
}

/// 前端侧：发一个请求，返回 `data`。
///
/// 失败一律归一成“启动器没运行/没就绪”这类一句话，前端据此把 TDP 区显示为不可用，
/// 其余功能照常 —— 这正是 FRONTEND.md §4 要的行为。
pub fn request(cmd: &str, watts: Option<u32>) -> Result<serde_json::Value, String> {
    let discovery = read_discovery()?;
    if discovery.proto != PROTO {
        return Err(format!(
            "启动器版本不匹配（启动器协议 {}，前端需要 {PROTO}）",
            discovery.proto
        ));
    }
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, discovery.port);
    let stream = TcpStream::connect_timeout(&addr.into(), IO_TIMEOUT)
        .map_err(|_| "启动器没在运行".to_string())?;
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

    let request = Request {
        proto: PROTO,
        token: discovery.token.clone(),
        id: 1,
        cmd: cmd.to_string(),
        watts,
    };
    let mut body = serde_json::to_string(&request).map_err(|err| err.to_string())?;
    body.push('\n');

    let mut writer = stream.try_clone().map_err(|err| err.to_string())?;
    writer
        .write_all(body.as_bytes())
        .map_err(|_| "启动器没有响应".to_string())?;
    let _ = writer.flush();

    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|_| "启动器没有响应".to_string())?;
    let response: Response =
        serde_json::from_str(line.trim()).map_err(|err| format!("响应无法解析：{err}"))?;
    if response.ok {
        Ok(response.data.unwrap_or(serde_json::Value::Null))
    } else {
        Err(response
            .error
            .unwrap_or_else(|| "启动器拒绝了请求".to_string()))
    }
}

/// 启动器侧：把一行请求解析成 `Request`，token 与协议版本都在这里校验。
pub fn parse_request(line: &str, token: &str) -> Result<Request, String> {
    let request: Request = serde_json::from_str(line.trim()).map_err(|err| err.to_string())?;
    if request.token != token {
        return Err("token 不对".to_string());
    }
    if request.proto != PROTO {
        return Err(format!("协议版本不匹配（{PROTO} vs {}）", request.proto));
    }
    Ok(request)
}
