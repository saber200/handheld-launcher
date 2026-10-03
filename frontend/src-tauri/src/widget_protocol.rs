//! 独立 Widget 协议；不接受路径，不容忍未知字段或隐式类型转换。
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
    // set_autostart 在这里是完整可用的，但 Bridge 的白名单只有 status / set_tdp /
    // quit_game / set_locale（见 frontend/gamebar/Bridge/Loopback.cs 的 extra 分支），
    // 小组件根本发不出来 —— 它那边的「自启」开关只存本地意图、提示用户手动关。
    // 要么以后把这条放进白名单，要么连这里一起删；别以为小组件能改自启。
    #[serde(rename = "set_autostart")]
    SetAutostart { proto: u32, id: String, token: String, enabled: bool },
}

impl Request {
    fn envelope(&self) -> (u32, &str, &str) {
        match self {
            Self::Status { proto, id, token } |
            Self::SetTdp { proto, id, token, .. } |
            Self::QuitGame { proto, id, token, .. } |
            Self::SetLocale { proto, id, token, .. } |
            Self::SetAutostart { proto, id, token, .. } => (*proto, id, token),
        }
    }
    pub fn id(&self) -> &str { self.envelope().1 }
}

fn token_matches(actual: &str, expected: &str) -> bool {
    if actual.len() != expected.len() || expected.is_empty() { return false; }
    actual.bytes().zip(expected.bytes()).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

pub fn parse(line: &[u8], token: &str) -> Result<Request, &'static str> {
    if line.len() > MAX_REQUEST || line.last() != Some(&b'\n') || line[..line.len().saturating_sub(1)].contains(&b'\n') {
        return Err("Invalid request framing");
    }
    let text = std::str::from_utf8(line).map_err(|_| "Invalid UTF-8")?;
    // Never echo deserializer diagnostics: they may contain the credential.
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
        for (cmd, args) in [("status", ""), ("set_tdp", ",\"watts\":15"), ("quit_game", ",\"gameId\":\"game\""), ("set_locale", ",\"locale\":\"en-US\""), ("set_autostart", ",\"enabled\":false")] {
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
}