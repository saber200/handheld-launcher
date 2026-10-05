//! Game Bar 小组件的回环协议。
//!
//! 这份协议是从已删掉的独立前端（`git show v0.1.61:frontend/src-tauri/src/widget_protocol.rs`）
//! 原样搬回来的，只去掉了 `set_autostart`。为什么不趁机重写：C# 那边
//! （`frontend/gamebar/Bridge/Loopback.cs` 与 `Widget/*.cs`）把字段名、长度上限、命令白名单
//! 全写死了，改一个字段就得连 UWP 一起改、再去 Windows 上重新验证一轮。搬回来＝契约不变。
//!
//! `set_autostart` 为什么不留：Bridge 的白名单只有 status / set_tdp / quit_game / set_locale
//! （见 `Loopback.cs` 的 `extra` 分支），小组件根本发不出来。启动器自启仍只在启动器设置里改。
use serde::Deserialize;
use serde_json::{json, Value};

pub const MAX_REQUEST: usize = 4096;
pub const MAX_RESPONSE: usize = 24000;

#[derive(Deserialize)]
#[serde(tag = "cmd", deny_unknown_fields)]
pub enum Request {
    #[serde(rename = "status")]
    Status { proto: u32, id: String, token: String },
    #[serde(rename = "set_tdp")]
    SetTdp { proto: u32, id: String, token: String, watts: u32 },
    #[serde(rename = "quit_game")]
    QuitGame { proto: u32, id: String, token: String, #[serde(rename = "gameId")] game_id: String },
    #[serde(rename = "set_locale")]
    SetLocale { proto: u32, id: String, token: String, locale: String },
}

impl Request {
    fn envelope(&self) -> (u32, &str, &str) {
        match self {
            Self::Status { proto, id, token }
            | Self::SetTdp { proto, id, token, .. }
            | Self::QuitGame { proto, id, token, .. }
            | Self::SetLocale { proto, id, token, .. } => (*proto, id, token),
        }
    }
    pub fn id(&self) -> &str { self.envelope().1 }
}

/// 由操作系统安全随机源生成的 256 位十六进制令牌。
///
/// 注意：能读发现文件的同用户进程也能读走它 —— 它是「别的进程别误连」的凭证，
/// **不是**同用户之间的隔离机制（HANDOFF.txt 里也是这么写的）。
pub fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|err| format!("无法生成回环令牌：{err}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// 定长逐字节比较：不提前返回，避免用耗时差异猜令牌。
fn token_matches(actual: &str, expected: &str) -> bool {
    if actual.len() != expected.len() || expected.is_empty() { return false; }
    actual.bytes().zip(expected.bytes()).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

pub fn parse(line: &[u8], token: &str) -> Result<Request, &'static str> {
    if line.len() > MAX_REQUEST || line.last() != Some(&b'\n') || line[..line.len().saturating_sub(1)].contains(&b'\n') {
        return Err("Invalid request framing");
    }
    let text = std::str::from_utf8(line).map_err(|_| "Invalid UTF-8")?;
    // 绝不回显反序列化器的报错：里面可能带着令牌。
    let request: Request = serde_json::from_str(text).map_err(|_| "Invalid request")?;
    let (proto, id, supplied) = request.envelope();
    if proto != 1 || id.trim().is_empty() || id.encode_utf16().count() > 64 {
        return Err("Invalid protocol or request id");
    }
    if !token_matches(supplied, token) { return Err("Unauthorized"); }
    match &request {
        Request::SetTdp { watts, .. } if !(1..=1000).contains(watts) => return Err("Invalid watts"),
        Request::QuitGame { game_id, .. } if game_id.trim().is_empty() || game_id.encode_utf16().count() > 512 => return Err("Invalid game id"),
        Request::SetLocale { locale, .. } if locale != "zh-CN" && locale != "en-US" => return Err("Unsupported locale"),
        _ => {}
    }
    Ok(request)
}

pub fn response(id: &str, result: Result<Value, String>) -> Vec<u8> {
    let value = match result {
        Ok(data) => json!({"id":id,"ok":true,"data":data}),
        Err(error) => json!({"id":id,"ok":false,"error":error}),
    };
    let mut text = value.to_string();
    // 超限时不截断 JSON（截了就是不可解析的碎片），而是换成一个明确的错误回复。
    if text.encode_utf16().count() + 1 > MAX_RESPONSE {
        text = json!({"id":id,"ok":false,"error":"Response exceeds size limit"}).to_string();
    }
    text.push('\n');
    text.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(cmd: &str, args: &str) -> String {
        format!("{{\"proto\":1,\"id\":\"x\",\"token\":\"secret\",\"cmd\":\"{cmd}\"{args}}}\n")
    }
    #[test]
    fn accepts_all_commands() {
        for (cmd, args) in [("status", ""), ("set_tdp", ",\"watts\":15"), ("quit_game", ",\"gameId\":\"game\""), ("set_locale", ",\"locale\":\"en-US\"")] {
            assert!(parse(request(cmd, args).as_bytes(), "secret").is_ok());
        }
    }
    #[test]
    fn rejects_unknown_duplicate_and_wrong_types() {
        for (cmd, args) in [("status", ",\"path\":\"x\""), ("status", ",\"watts\":null"), ("status", ",\"id\":\"y\""), ("status", ",\"cmd\":\"status\""), ("status", ",\"proto\":1"), ("status", ",\"token\":\"secret\""), ("set_tdp", ",\"watts\":1.0"), ("set_tdp", ",\"watts\":0"), ("set_tdp", ",\"watts\":1001"), ("quit_game", ",\"gameId\":\"  \""), ("set_locale", ",\"locale\":\"en\""), ("set_autostart", ",\"enabled\":1")] {
            assert!(parse(request(cmd, args).as_bytes(), "secret").is_err(), "{cmd} {args}");
        }
    }
    #[test]
    fn authentication_and_framing() {
        let line = request("status", "");
        assert!(parse(line.as_bytes(), "other!").is_err());
        assert!(parse(line.trim_end().as_bytes(), "secret").is_err());
        assert!(parse(format!("{line}{line}").as_bytes(), "secret").is_err());
        assert!(parse(&[0xff, b'\n'], "secret").is_err());
        assert!(parse(&[], "secret").is_err());
        let mut padded = line.trim_end().to_string();
        padded.extend(std::iter::repeat_n(' ', MAX_REQUEST - padded.len() - 1));
        padded.push('\n');
        assert!(parse(padded.as_bytes(), "secret").is_ok());
        padded.insert(0, ' ');
        assert!(parse(padded.as_bytes(), "secret").is_err());
    }
    #[test]
    fn id_and_game_id_limits_use_utf16() {
        for (units, valid) in [(64, true), (65, false)] {
            let line = request("status", "").replace("\"x\"", &format!("\"{}\"", "a".repeat(units)));
            assert_eq!(parse(line.as_bytes(), "secret").is_ok(), valid);
        }
        for (count, valid) in [(256, true), (257, false)] {
            let line = request("quit_game", &format!(",\"gameId\":\"{}\"", "😀".repeat(count)));
            assert_eq!(parse(line.as_bytes(), "secret").is_ok(), valid);
        }
    }
    #[test]
    fn oversized_response_is_an_error_not_truncated_json() {
        let bytes = response("x", Ok(json!({"text":"😀".repeat(MAX_RESPONSE)})));
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(text.encode_utf16().count() <= MAX_RESPONSE);
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["id"], "x");
        assert!(value.get("data").is_none());
    }
    /// 令牌必须每次都不一样（同端口重启后旧凭证立刻失效），且是 64 位十六进制。
    #[test]
    fn token_is_fresh_hex() {
        let first = random_token().unwrap();
        let second = random_token().unwrap();
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}
