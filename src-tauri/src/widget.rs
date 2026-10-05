//! 小组件的回环传输层（从已删除的独立前端 `widget.rs` 搬进启动器）。
//!
//! 为什么并进启动器、而不是再起一个后台进程：老链路是「小组件 → Bridge → 独立前端
//! →(回环 IPC)→ 启动器」，可 TDP 一直只归启动器管（只有它装了 WinRing0、能提权），
//! 独立前端从头到尾只是个转发器。启动器本来就常驻、开机自启，把后端并进来少一层进程、
//! 少一处版本漂移，命令也就地调用（见 `dispatch`）。
//!
//! 代价（与老架构相同，不是新引入的）：用户在「电源 → 退出」里真的退出启动器后，
//! 小组件就没数据了 —— 以前 TDP 也一样要启动器在跑。
//!
//! 安全边界：只绑回环、一连接一请求、令牌定长逐字节比较、请求 4096 字节上限、
//! 读/工作/总预算分开计时（慢的读和卡住的平台调用各自有独立上限）。
use crate::widget_protocol::{self as protocol, Request};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{atomic::{AtomicUsize, Ordering}, mpsc, Arc};
use std::time::{Duration, Instant};

const CONNECTIONS: usize = 8;
const WORKERS: usize = 8;
const READ_BUDGET: Duration = Duration::from_secs(1);
const WORK_BUDGET: Duration = Duration::from_secs(6);
const TOTAL_BUDGET: Duration = Duration::from_secs(7);
const TIMEOUT: &str = "Backend deadline exceeded; an operation already started may complete later";

/// 上限计数器：超出就拒绝，而不是排队等（有界，防止请求堆积把启动器拖住）。
#[derive(Default)]
struct Limit(AtomicUsize);
struct Permit(Arc<Limit>);
impl Limit {
    fn acquire(self: &Arc<Self>, maximum: usize) -> Option<Permit> {
        self.0.fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
            (count < maximum).then_some(count + 1)
        }).ok().map(|_| Permit(self.clone()))
    }
}
impl Drop for Permit {
    fn drop(&mut self) { self.0.0.fetch_sub(1, Ordering::Release); }
}

type JobResult = Result<Value, String>;

/// 把一件事丢进有界工作线程池，带截止时间。
fn submit(workers: &Arc<Limit>, deadline: Instant, work: impl FnOnce() -> JobResult + Send + 'static)
    -> Result<mpsc::Receiver<JobResult>, String>
{
    let permit = workers.acquire(WORKERS).ok_or("Backend busy")?;
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::Builder::new().name("widget-work".into()).spawn(move || {
        let _permit = permit;
        let result = if Instant::now() >= deadline { Err(TIMEOUT.into()) } else { work() };
        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;
    Ok(rx)
}

fn receive(job: Result<mpsc::Receiver<JobResult>, String>, deadline: Instant) -> JobResult {
    job?.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => TIMEOUT.to_string(),
            mpsc::RecvTimeoutError::Disconnected => "Backend worker stopped".to_string(),
        })?
}

/// 起后台：绑一个随机回环端口、生成令牌、把两者写进发现文件，然后开始收连接。
///
/// 起点失败一律返回错误交给调用方去记日志 —— 启动器不因为小组件后端起不来就起不来
/// （老版本这里是 `?`，因为那时整个进程就只干这一件事）。
pub fn start() -> Result<(), io::Error> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let token = protocol::random_token().map_err(io::Error::other)?;
    crate::widget_discovery::publish(listener.local_addr()?.port(), &token).map_err(io::Error::other)?;
    let result = std::thread::Builder::new().name("widget-listen".into()).spawn(move || {
        let connections = Arc::new(Limit::default());
        let workers = Arc::new(Limit::default());
        for incoming in listener.incoming() {
            let Ok(stream) = incoming else { continue; };
            let accepted = Instant::now();
            let Some(permit) = connections.acquire(CONNECTIONS) else { continue; };
            let (token, workers) = (token.clone(), workers.clone());
            let _ = std::thread::Builder::new().name("widget-peer".into()).spawn(move || {
                let _permit = permit;
                serve(stream, &token, accepted, |request, deadline| dispatch(request, workers, deadline));
            });
        }
    });
    if let Err(error) = result {
        // 监听线程起不来就别在盘上留着「后端可用」的假线索。
        let _ = crate::widget_discovery::revoke();
        return Err(error);
    }
    Ok(())
}

/// 还剩多少时间可用；已经过期就直接超时（不把负的时长喂给 socket 超时设置）。
fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "Widget deadline exceeded"))
}

fn read_request(stream: &mut TcpStream, deadline: Instant) -> io::Result<Vec<u8>> {
    let mut line = Vec::with_capacity(protocol::MAX_REQUEST);
    // 每次读都用「总预算还剩多少」，而不是每读一个字节就续一次 —— 否则慢速发送方
    // 可以一直续命，把连接占住。
    while line.len() < protocol::MAX_REQUEST {
        stream.set_read_timeout(Some(remaining(deadline)?))?;
        let mut byte = [0];
        if stream.read(&mut byte)? == 0 { return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "Incomplete request")); }
        line.push(byte[0]);
        if byte[0] == b'\n' { return Ok(line); }
    }
    Err(io::Error::new(io::ErrorKind::InvalidData, "Request exceeds size limit"))
}

fn write_response(stream: &mut TcpStream, bytes: &[u8], deadline: Instant) -> io::Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        let written = stream.write(&bytes[offset..])?;
        if written == 0 { return Err(io::Error::new(io::ErrorKind::WriteZero, "Response write failed")); }
        offset += written;
    }
    Ok(())
}

fn serve(mut stream: TcpStream, token: &str, accepted: Instant,
    dispatch: impl FnOnce(Request, Instant) -> JobResult)
{
    let (id, result) = match read_request(&mut stream, accepted + READ_BUDGET) {
        Ok(line) => match protocol::parse(&line, token) {
            Ok(request) => (request.id().to_string(), dispatch(request, accepted + WORK_BUDGET)),
            Err(error) => (String::new(), Err(error.into())),
        },
        Err(error) => (String::new(), Err(error.to_string())),
    };
    let _ = write_response(&mut stream, &protocol::response(&id, result), accepted + TOTAL_BUDGET);
}

fn dispatch(request: Request, workers: Arc<Limit>, deadline: Instant) -> JobResult {
    match request {
        Request::Status { .. } => {
            // 这三件事就地做（同一个进程里），不再像老架构那样转发给另一个程序。
            let driver = submit(&workers, deadline, || serde_json::to_value(crate::toolbox::toolbox_tdp_driver_status_now())
                .map_err(|error| error.to_string()));
            let tdp = submit(&workers, deadline, || serde_json::to_value(crate::tdp::tdp_status_now())
                .map_err(|error| error.to_string()));
            let games = submit(&workers, deadline, running_games);
            // driver 与 tdp 各自独立失败：一边坏了不该把另一边也变成错误 ——
            // 小组件按这两个字段分别决定「显示滑条 / 引导装驱动 / 提示不支持」。
            let (driver, driver_error) = partial(receive(driver, deadline));
            let (tdp, tdp_error) = partial(receive(tdp, deadline));
            // 但游戏列表卡住 ≠ 空列表：返回空列表会让小组件把「退出游戏」当成没有对象，
            // 那是撒谎；这里直接把超时当失败报上去。
            let games = receive(games, deadline)?;
            // locale 是小组件与启动器对齐语言的唯一来源（缺了它小组件只会显示系统语言，
            // 因为 set_locale 只影响当次会话）。
            Ok(json!({"driver":driver,"driverError":driver_error,"tdp":tdp,"tdpError":tdp_error,"games":games,"locale":crate::i18n::locale()}))
        }
        request => receive(submit(&workers, deadline, move || match request {
            Request::SetTdp { watts, .. } => crate::tdp::set_tdp_now(watts)
                .and_then(|info| serde_json::to_value(info).map_err(|error| error.to_string())),
            Request::QuitGame { game_id, .. } => quit_game(&game_id),
            Request::SetLocale { locale, .. } => {
                crate::i18n::apply(&locale);
                Ok(json!({"locale": crate::i18n::locale()}))
            }
            Request::Status { .. } => unreachable!(),
        }), deadline),
    }
}

fn partial(result: JobResult) -> (Value, Value) {
    match result { Ok(data) => (data, Value::Null), Err(error) => (Value::Null, Value::String(error)) }
}

/// 清单里「现在正在跑」的那些游戏（小组件的下拉框选择退出对象）。
fn running_games() -> JobResult {
    let games = crate::library::read_published();
    let queries: Vec<_> = games.iter().map(|game| fh_core::process::RunningQuery {
        id: game.id.clone(), launch_path: game.launch_path.clone(), install_path: game.install_path.clone(),
    }).collect();
    let running: std::collections::HashSet<_> = fh_core::process::running_ids(&queries).into_iter().collect();
    Ok(Value::Array(games.into_iter().filter(|game| running.contains(&game.id))
        .map(|game| json!({"id":game.id,"name":game.name})).collect()))
}

fn quit_game(game_id: &str) -> JobResult {
    let games = crate::library::read_published();
    let mut matches = games.iter().filter(|game| game.id == game_id);
    let game = matches.next().ok_or("Game is not in the published library")?;
    if matches.next().is_some() { return Err("Ambiguous published game id".into()); }
    if game.launch_path.trim().is_empty() && game.install_path.trim().is_empty() {
        return Err("Published game has no process path".into());
    }
    Ok(json!({"killed":fh_core::process::kill_game(&game.launch_path, &game.install_path)}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    /// 真开一条回环连接把整条路跑通：帧校验 → 令牌 → 就地办事 → 回包形状。
    ///
    /// 只测 `status`：`set_tdp` 会写 MSR，测试里绝不能碰。这里也**不发布发现文件**
    /// （`start()` 才会），免得污染开发机上的真实 `widget-ipc.json`。
    #[test]
    fn status_round_trips_over_loopback() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = protocol::random_token().unwrap();
        let accepted_token = token.clone();
        let worker = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let workers = Arc::new(Limit::default());
            serve(stream, &accepted_token, Instant::now(), |request, deadline| dispatch(request, workers, deadline));
        });
        let response = send(port, &format!("{{\"proto\":1,\"id\":\"t\",\"token\":\"{token}\",\"cmd\":\"status\"}}\n"));
        worker.join().unwrap();
        let value: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(value["id"], "t");
        assert_eq!(value["ok"], true);
        let data = &value["data"];
        for key in ["driver", "driverError", "tdp", "tdpError", "games", "locale"] {
            assert!(data.get(key).is_some(), "status.data 少了 {key}");
        }
        // 下面这几个键名是 C# 侧（frontend/gamebar/Widget/Models.cs）逐字写死的：
        // 改名 = 小组件直接把这段数据当无效丢掉，所以在这里钉住。
        assert!(data["tdp"]["minW"].is_number(), "缺 minW");
        assert!(data["tdp"]["maxW"].is_number(), "缺 maxW");
        assert!(data["driver"]["ready"].is_boolean(), "缺 driver.ready");
        assert!(data["driver"]["installed"].is_boolean(), "缺 driver.installed");
        assert!(data["games"].is_array());
        assert!(matches!(data["locale"].as_str(), Some("zh-CN") | Some("en-US")));
    }

    /// 令牌不对要给明确的错误回包，不能被当成成功。
    #[test]
    fn wrong_token_is_rejected() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let workers = Arc::new(Limit::default());
            serve(stream, "secret", Instant::now(), |request, deadline| dispatch(request, workers, deadline));
        });
        let response = send(port, "{\"proto\":1,\"id\":\"t\",\"token\":\"guess\",\"cmd\":\"status\"}\n");
        worker.join().unwrap();
        let value: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"], "Unauthorized");
        assert!(value.get("data").is_none());
    }

    fn send(port: u16, body: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        stream.write_all(body.as_bytes()).unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        line
    }
}
