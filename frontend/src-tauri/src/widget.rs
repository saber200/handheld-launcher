//! Loopback Widget transport. Slow peers and hung platform calls have separate bounds.
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

pub fn start(app: tauri::AppHandle) -> Result<(), io::Error> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let token = fh_core::ipc::random_token().map_err(io::Error::other)?;
    crate::widget_discovery::publish(listener.local_addr()?.port(), &token).map_err(io::Error::other)?;
    let result = std::thread::Builder::new().name("widget-listen".into()).spawn(move || {
        let connections = Arc::new(Limit::default());
        let workers = Arc::new(Limit::default());
        for incoming in listener.incoming() {
            let Ok(stream) = incoming else { continue; };
            let accepted = Instant::now();
            let Some(permit) = connections.acquire(CONNECTIONS) else { continue; };
            let (app, token, workers) = (app.clone(), token.clone(), workers.clone());
            let _ = std::thread::Builder::new().name("widget-peer".into()).spawn(move || {
                let _permit = permit;
                serve(stream, &token, accepted, |request, deadline| dispatch(request, app, workers, deadline));
            });
        }
    });
    if let Err(error) = result {
        let _ = crate::widget_discovery::revoke();
        return Err(error);
    }
    Ok(())
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "Widget deadline exceeded"))
}

fn read_request(stream: &mut TcpStream, deadline: Instant) -> io::Result<Vec<u8>> {
    let mut line = Vec::with_capacity(protocol::MAX_REQUEST);
    // Each read uses the remaining TOTAL budget, not a sliding per-byte timeout.
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

fn dispatch(request: Request, app: tauri::AppHandle, workers: Arc<Limit>, deadline: Instant) -> JobResult {
    match request {
        Request::Status { .. } => {
            let driver = submit(&workers, deadline, || crate::tdp_client::toolbox_tdp_driver_status()
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())));
            let tdp = submit(&workers, deadline, || crate::tdp_client::tdp_status()
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())));
            let games = submit(&workers, deadline, running_games);
            let (driver, driver_error) = partial(receive(driver, deadline));
            let (tdp, tdp_error) = partial(receive(tdp, deadline));
            // Do not turn a hung enumeration into a successful empty games list.
            let games = receive(games, deadline)?;
            // locale 是小组件与后台对齐语言的唯一来源：Bridge/Widget 读 status.locale，
            // 缺了它 Widget 永远拿不到语言，set_locale 只在本次会话内有效。
            Ok(json!({"driver":driver,"driverError":driver_error,"tdp":tdp,"tdpError":tdp_error,"games":games,"locale":crate::text::locale()}))
        }
        request => receive(submit(&workers, deadline, move || match request {
            Request::SetTdp { watts, .. } => crate::tdp_client::set_tdp(watts)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
            Request::QuitGame { game_id, .. } => quit_game(&game_id),
            Request::SetLocale { locale, .. } => {
                crate::text::apply(&locale);
                crate::tray::refresh(&app);
                Ok(json!({"locale":crate::text::locale()}))
            }
            Request::SetAutostart { enabled, .. } => crate::tray::set_autostart(&app, enabled)
                .map(|actual| json!({"enabled":actual})),
            Request::Status { .. } => unreachable!(),
        }), deadline),
    }
}

fn partial(result: JobResult) -> (Value, Value) {
    match result { Ok(data) => (data, Value::Null), Err(error) => (Value::Null, Value::String(error)) }
}

fn running_games() -> JobResult {
    let games = fh_core::library::read_published();
    let queries: Vec<_> = games.iter().map(|game| fh_core::process::RunningQuery {
        id: game.id.clone(), launch_path: game.launch_path.clone(), install_path: game.install_path.clone(),
    }).collect();
    let running: std::collections::HashSet<_> = fh_core::process::running_ids(&queries).into_iter().collect();
    Ok(Value::Array(games.into_iter().filter(|game| running.contains(&game.id))
        .map(|game| json!({"id":game.id,"name":game.name})).collect()))
}

fn quit_game(game_id: &str) -> JobResult {
    let games = fh_core::library::read_published();
    let mut matches = games.iter().filter(|game| game.id == game_id);
    let game = matches.next().ok_or("Game is not in the published library")?;
    if matches.next().is_some() { return Err("Ambiguous published game id".into()); }
    if game.launch_path.trim().is_empty() && game.install_path.trim().is_empty() {
        return Err("Published game has no process path".into());
    }
    Ok(json!({"killed":fh_core::process::kill_game(&game.launch_path, &game.install_path)}))
}