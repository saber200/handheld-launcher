//! 前端的「开机自启 / 保命」—— 用**计划任务**，不再只靠 HKCU Run。
//!
//! 为什么换（0.1.53 真机结论）：Win11 的「Xbox 模式（全屏体验）」把启动器设成主页应用之后，
//! 那个会话里**没有桌面 shell（explorer）** —— 而 `HKCU\...\Run` 正是由 explorer 在登录时
//! 处理的，于是 FSE 里前端**根本不会被启动**。用户看到的就是「开机后前端不在」（很像"被杀"，
//! 其实是没被启动）。OneXConsole 这类厂商程序用的是服务 / 计划任务（由任务计划程序拉起），
//! 任何会话都在 —— 差别就在这里，不是它们写了什么护身符。
//!
//! 换到计划任务还顺手解决两件事：
//!
//! 1. **权限一致**：任务可以指定「以当前用户、**不提权**」运行。安装器（提权链）直接
//!    `Exec` 拉起来的前端是**管理员**进程，Run 键拉起来的是普通权限 —— 同一个程序两种权限，
//!    UIPI（低完整性进程排不到高完整性窗口上面）在不同会话下表现不一样。走任务就只有一种。
//! 2. **保命**：任务配了「失败后重启」，而**优雅退出（exit code 0）不会触发重启** ——
//!    用户从托盘点「退出前端」的意图天然被尊重，崩溃 / 被杀则会被拉回来。这正是我们想要的
//!    语义，而且不需要任何额外的「用户意图」开关。
//!
//! 手法是 `schtasks`（Windows 自带）：`/create /xml` 一次写全所有策略
//! （`RunLevel=LeastPrivilege` / `RestartOnFailure` / `MultipleInstances=IgnoreNew` /
//! 登录后延迟 10 秒 / `ExecutionTimeLimit=PT0S` 即永不超时结束 —— 托盘常驻程序**必须**有
//! 这一条，否则任务计划程序默认三天后把它结束掉）。任务 XML 必须是 **UTF-16LE + BOM**，
//! `schtasks` 才认。
//!
//! 非 Windows 上这些只是空实现（本机 `cargo check` 也编得过）。

use std::path::{Path, PathBuf};

/// 计划任务名。启动器与前端两边只认这一个名字。
pub const TASK_NAME: &str = "FantasyHubFrontend";

/// 「用户刚主动退出过前端」的标记文件。
///
/// 用途：启动器启动时会补一次「前端在跑」（见启动器的 `frontend_tool::ensure_running`），
/// 但用户从托盘点了「退出前端」是**明确意图**，不能因为启动器重启又被拉起来。
/// 下一次登录时计划任务会用 `--autostart` 启动前端，前端在那一轮把它删掉 ——
/// 于是「意图」只在一个登录会话里有效，语义与以前的 Run 键一致。
pub fn stopped_marker() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata)
                .join("handheld-launcher")
                .join("frontend-stopped");
        }
    }
    std::env::temp_dir().join("fantasyhub-frontend-stopped")
}

/// 前端从托盘点「退出」时写一个；失败必须由调用方反馈，不能假装已记录意图。
pub fn mark_stopped() -> Result<(), String> {
    write_marker(&stopped_marker(), "user quit the frontend from the tray\n")
}

/// 自启新会话清除退出标记；只有文件本来不存在可以忽略。
pub fn clear_stopped() -> Result<(), String> {
    let path = stopped_marker();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("删除标记 {} 失败：{err}", path.display())),
    }
}

/// 这一轮登录里用户是不是主动退过前端。
pub fn stopped_by_user() -> bool {
    stopped_marker().exists()
}

/// 本地用户意图，仅供任务缺失时参考；已有任务必须以 task_state 为准。
/// 文件缺失、合法开关、读取失败/损坏分别返回 None、Some、Err。
pub fn autostart_switch() -> Result<Option<bool>, String> {
    let path = switch_path();
    match std::fs::read_to_string(&path) {
        Ok(text) => match text.trim() {
            "on" => Ok(Some(true)),
            "off" => Ok(Some(false)),
            _ => Err(format!("自启标记 {} 内容无效", path.display())),
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("读取自启标记 {} 失败：{err}", path.display())),
    }
}

/// 写入本地用户意图；不能代替实际任务状态。
pub fn set_autostart_switch(on: bool) -> Result<(), String> {
    write_marker(&switch_path(), if on { "on\n" } else { "off\n" })
}

fn write_marker(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("创建标记目录 {} 失败：{err}", parent.display()))?;
    }
    std::fs::write(path, content)
        .map_err(|err| format!("写入标记 {} 失败：{err}", path.display()))
}

fn switch_path() -> PathBuf {
    stopped_marker().with_file_name("frontend-autostart")
}

/// 实际计划任务配置状态；查询失败通过 Result::Err 独立表示。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskState {
    Missing,
    Enabled,
    Disabled,
}

#[cfg(any(windows, test))]
fn parse_task_state(text: &str) -> Result<TaskState, String> {
    match text.trim() {
        "Missing" => Ok(TaskState::Missing),
        "Enabled" => Ok(TaskState::Enabled),
        "Disabled" => Ok(TaskState::Disabled),
        other => Err(format!("无法识别计划任务状态：{other:?}")),
    }
}

// ---------------------------------------------------------------------------
// 计划任务（Windows）
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use super::TASK_NAME;

    /// 跑一个 `schtasks` 子命令，**不带控制台窗口**（启动器/前端都是 GUI 子系统，
    /// 闪一下黑框就太糙了）。
    fn schtasks(args: &[&str]) -> std::io::Result<std::process::Output> {
        use std::os::windows::process::CommandExt;
        /// `CREATE_NO_WINDOW`
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("schtasks")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    }

    /// 系统 PowerShell 仅桥接 COM；stdout 是固定协议，不解析本地化 schtasks 文本。
    fn powershell(script: &str) -> Result<String, String> {
        use std::os::windows::process::CommandExt;
        let system_root = std::env::var_os("SystemRoot")
            .ok_or_else(|| "读不到 SystemRoot".to_string())?;
        let exe = PathBuf::from(system_root)
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let script = format!(
            "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); try {{ {script} }} catch {{ [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }}"
        );
        let out = Command::new(exe)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &script])
            .env("FH_AUTOSTART_TASK", TASK_NAME)
            .creation_flags(0x0800_0000)
            .output()
            .map_err(|err| format!("启动 Task Scheduler 桥接失败：{err}"))?;
        if !out.status.success() {
            return Err(format!("自启操作失败（退出码 {:?}）：{}", out.status.code(), stderr_of(&out)));
        }
        String::from_utf8(out.stdout)
            .map(|text| text.trim().to_string())
            .map_err(|err| format!("自启状态输出编码错误：{err}"))
    }

    fn with_task(body: &str, missing: &str) -> Result<String, String> {
        powershell(&format!(r#"
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
try {{ $task = $folder.GetTask($env:FH_AUTOSTART_TASK) }} catch {{
    $errorObject = $_.Exception
    $notFound = $false
    while ($null -ne $errorObject) {{
        if ($errorObject.HResult -eq -2147024894) {{ $notFound = $true }}
        $errorObject = $errorObject.InnerException
    }}
    if ($notFound) {{ {missing}; return }}
    throw
}}
{body}
"#))
    }

    pub fn task_state() -> Result<super::TaskState, String> {
        let text = with_task(
            "if ($task.Definition.Settings.Enabled) { 'Enabled' } else { 'Disabled' }",
            "'Missing'",
        )?;
        super::parse_task_state(&text)
    }

    /// 兼容存在性查询，但不再吞掉查询错误；决策应优先使用 task_state。
    pub fn task_exists() -> Result<bool, String> {
        task_state().map(|state| state != super::TaskState::Missing)
    }

    /// 按任务启动一次（`schtasks /run`）。**即使由提权的启动器调用，起来的也仍然是普通权限** ——
    /// 任务里写的是 `RunLevel=LeastPrivilege`，这正是我们要的（前端不该是管理员进程）。
    pub fn run_task() -> Result<String, String> {
        let out = schtasks(&["/run", "/tn", TASK_NAME]).map_err(|err| err.to_string())?;
        if out.status.success() {
            Ok("run ok".to_string())
        } else {
            Err(format!(
                "run failed（退出码 {:?}）{}",
                out.status.code(),
                stderr_of(&out)
            ))
        }
    }

    /// 托盘菜单里那个「开机自启」勾选框：开 / 关任务。关掉之后启动器与前端都不会再拉它
    /// （下次登录也不起来），但**不影响**前端此刻的运行。
    pub fn set_task_enabled(on: bool) -> Result<String, String> {
        let enabled = if on { "$true" } else { "$false" };
        let result = with_task(&format!(
            "$task.Enabled = {enabled}; if ([bool]$folder.GetTask($env:FH_AUTOSTART_TASK).Definition.Settings.Enabled -ne {enabled}) {{ throw 'Task enabled verification failed' }}; 'Updated'"
        ), "throw 'Task does not exist'")?;
        if result != "Updated" {
            return Err(format!("未知任务切换结果：{result:?}"));
        }
        Ok(format!("set enabled={on} ok"))
    }

    /// 删除任务（卸载 / 清理时用）。
    pub fn delete_task() -> Result<String, String> {
        let out = schtasks(&["/delete", "/f", "/tn", TASK_NAME]).map_err(|err| err.to_string())?;
        if out.status.success() {
            Ok("deleted".to_string())
        } else {
            Err(format!(
                "delete failed（退出码 {:?}）{}",
                out.status.code(),
                stderr_of(&out)
            ))
        }
    }

    /// 只在确认缺失时新建；已有任务仅迁移限制，不改变动作、主体、触发器或禁用意图。
    /// Some 表示新建或迁移，None 表示无需修改。任何查询/迁移失败均返回 Err。
    pub fn ensure_task_if_missing(exe: &Path) -> Result<Option<String>, String> {
        let outcome = match task_state()? {
            super::TaskState::Missing => {
                if super::autostart_switch()? == Some(false) {
                    return Ok(None);
                }
                if !exe.is_file() {
                    return Err(format!("前端不在 {}", exe.display()));
                }
                create_task(exe).map(Some)
            }
            super::TaskState::Enabled | super::TaskState::Disabled => migrate_task_settings(),
        }?;
        cleanup_legacy_run()
            .map_err(|err| format!("任务已确认/迁移，但旧 Run 清理失败：{err}"))?;
        Ok(outcome)
    }

    fn migrate_task_settings() -> Result<Option<String>, String> {
        let result = with_task(r#"
$definition = $task.Definition
$settings = $definition.Settings
$enabled = [bool]$settings.Enabled
$changed = $settings.DisallowStartIfOnBatteries -or $settings.StopIfGoingOnBatteries -or
    $settings.RunOnlyIfIdle -or $settings.IdleSettings.StopOnIdleEnd -or
    $settings.IdleSettings.RestartOnIdle -or ($settings.ExecutionTimeLimit -ne 'PT0S')
if (-not $changed) { 'Unchanged'; return }
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false
$settings.RunOnlyIfIdle = $false
$settings.IdleSettings.StopOnIdleEnd = $false
$settings.IdleSettings.RestartOnIdle = $false
$settings.ExecutionTimeLimit = 'PT0S'
$settings.Enabled = $enabled
$principal = $definition.Principal
$logonType = [int]$principal.LogonType
if ($logonType -eq 1 -or $logonType -eq 6) {
    throw 'Cannot migrate a password-based task without its credentials'
}
$identity = $principal.UserId
if ($logonType -eq 4) { $identity = $principal.GroupId }
# UPDATE only + DONT_ADD_PRINCIPAL_ACE + IGNORE_REGISTRATION_TRIGGERS.
# Keep the existing definition and security descriptor; never create on a race.
$null = $folder.RegisterTaskDefinition($task.Name, $definition, 52, $identity, $null, $logonType, $null)
$verified = $folder.GetTask($env:FH_AUTOSTART_TASK).Definition.Settings
if ([bool]$verified.Enabled -ne $enabled -or $verified.DisallowStartIfOnBatteries -or
    $verified.StopIfGoingOnBatteries -or $verified.RunOnlyIfIdle -or
    $verified.IdleSettings.StopOnIdleEnd -or $verified.IdleSettings.RestartOnIdle -or
    $verified.ExecutionTimeLimit -ne 'PT0S') { throw 'Task migration verification failed' }
'Migrated'
"#, "throw 'Task disappeared during migration'")?;
        match result.as_str() {
            "Unchanged" => Ok(None),
            "Migrated" => Ok(Some("migrated battery/idle/timeout settings; enabled state preserved".to_string())),
            _ => Err(format!("未知迁移结果：{result:?}")),
        }
    }

    /// 只删除前端历史 HKCU Run 值，不碰启动器、其他值或 StartupApproved。
    pub fn cleanup_legacy_run() -> Result<(), String> {
        let result = powershell(r#"
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $true)
if ($null -eq $key) { 'Clean'; return }
try {
    $key.DeleteValue('FantasyHubFrontend', $false)
    if ($key.GetValueNames() -contains 'FantasyHubFrontend') { throw 'Legacy Run cleanup verification failed' }
} finally { $key.Dispose() }
'Clean'
"#)?;
        if result == "Clean" { Ok(()) } else { Err(format!("未知旧 Run 清理结果：{result:?}")) }
    }

    /// 建立任务：登录后延迟 10 秒，以当前用户、**不提权**启动 `exe --autostart`。
    pub fn create_task(exe: &Path) -> Result<String, String> {
        let user = current_user()?;
        let xml = task_xml(exe, &user);
        let path = xml_path();
        write_utf16le(&path, &xml).map_err(|err| format!("写任务 XML 失败：{err}"))?;
        let path_text = path.display().to_string();
        let out = schtasks(&[
            "/create",
            "/tn",
            TASK_NAME,
            "/xml",
            path_text.as_str(),
        ])
        .map_err(|err| err.to_string())?;
        let _ = std::fs::remove_file(&path);
        if out.status.success() {
            Ok(format!("created user={user} exe={}", exe.display()))
        } else {
            Err(format!(
                "create failed（退出码 {:?}）{}",
                out.status.code(),
                stderr_of(&out)
            ))
        }
    }

    /// `schtasks` 的错误说明（中英文都可能），只取最后一行有用的往日志里写。
    fn stderr_of(out: &std::process::Output) -> String {
        let raw = if out.stderr.is_empty() {
            &out.stdout
        } else {
            &out.stderr
        };
        String::from_utf8_lossy(raw)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .next_back()
            .unwrap_or("")
            .to_string()
    }

    fn current_user() -> Result<String, String> {
        let name = std::env::var("USERNAME").map_err(|_| "读不到 USERNAME".to_string())?;
        Ok(match std::env::var("USERDOMAIN") {
            Ok(domain) if !domain.is_empty() => format!("{domain}\\{name}"),
            _ => name,
        })
    }

    fn xml_path() -> PathBuf {
        std::env::temp_dir().join("fantasyhub-frontend-task.xml")
    }

    /// 任务 XML。**必须是 UTF-16LE + BOM**，`schtasks /xml` 只认这一种；
    /// 编码错了会得到「XML 无效」这种看不出原因的报错。
    ///
    /// 几条关键设置：
    /// - `RunLevel=LeastPrivilege`：普通权限启动（前端不该是管理员进程）。
    /// - `MultipleInstancesPolicy=IgnoreNew`：不会叠出第二个（前端还有单实例插件兜底）。
    /// - `ExecutionTimeLimit=PT0S`：**永不超时结束**。托盘常驻程序必须有这条，
    ///   否则任务计划程序默认三天后把它结束掉（那就成了另一个「前端莫名其妙没了」）。
    /// - `RestartOnFailure` 1 分钟 / 最多 2 次：崩溃或被杀会被拉回来；
    ///   **优雅退出（exit code 0，比如托盘「退出前端」）不算失败，不会重启** —— 意图天然被尊重。
    /// - 登录触发 + 延迟 10 秒：等 shell 起来再出现托盘图标。
    fn task_xml(exe: &Path, user: &str) -> String {
        let exe = xml_escape(&exe.display().to_string());
        let user = xml_escape(user);
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
  <RegistrationInfo>\n\
    <Description>FantasyHub frontend (tray overlay: Back+Start / Ctrl+H)</Description>\n\
  </RegistrationInfo>\n\
  <Triggers>\n\
    <LogonTrigger>\n\
      <Enabled>true</Enabled>\n\
      <UserId>{user}</UserId>\n\
      <Delay>PT10S</Delay>\n\
    </LogonTrigger>\n\
  </Triggers>\n\
  <Principals>\n\
    <Principal id=\"Author\">\n\
      <UserId>{user}</UserId>\n\
      <LogonType>InteractiveToken</LogonType>\n\
      <RunLevel>LeastPrivilege</RunLevel>\n\
    </Principal>\n\
  </Principals>\n\
  <Settings>\n\
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n\
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n\
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n\
    <AllowHardTerminate>true</AllowHardTerminate>\n\
    <StartWhenAvailable>true</StartWhenAvailable>\n\
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n\
    <IdleSettings>\n\
      <StopOnIdleEnd>false</StopOnIdleEnd>\n\
      <RestartOnIdle>false</RestartOnIdle>\n\
    </IdleSettings>\n\
    <AllowStartOnDemand>true</AllowStartOnDemand>\n\
    <Enabled>true</Enabled>\n\
    <Hidden>false</Hidden>\n\
    <RunOnlyIfIdle>false</RunOnlyIfIdle>\n\
    <WakeToRun>false</WakeToRun>\n\
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n\
    <Priority>7</Priority>\n\
    <RestartOnFailure>\n\
      <Interval>PT1M</Interval>\n\
      <Count>2</Count>\n\
    </RestartOnFailure>\n\
  </Settings>\n\
  <Actions Context=\"Author\">\n\
    <Exec>\n\
      <Command>{exe}</Command>\n\
      <Arguments>--autostart</Arguments>\n\
    </Exec>\n\
  </Actions>\n\
</Task>\n"
        )
    }

    fn xml_escape(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    }

    fn write_utf16le(path: &Path, text: &str) -> std::io::Result<()> {
        let mut bytes: Vec<u8> = Vec::with_capacity(text.len() * 2 + 2);
        bytes.extend_from_slice(&[0xFF, 0xFE]);
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(path, bytes)
    }
}

#[cfg(windows)]
pub use win::{
    cleanup_legacy_run, create_task, delete_task, ensure_task_if_missing, run_task,
    set_task_enabled, task_exists, task_state,
};

/// 非 Windows 不支持任务查询，不伪装为 Windows 上的任务缺失。
#[cfg(not(windows))]
pub fn task_state() -> Result<TaskState, String> {
    Err("非 Windows 上没有计划任务".to_string())
}

#[cfg(not(windows))]
pub fn task_exists() -> Result<bool, String> {
    task_state().map(|state| state != TaskState::Missing)
}

#[cfg(not(windows))]
pub fn cleanup_legacy_run() -> Result<(), String> {
    Err("非 Windows 上没有 HKCU Run".to_string())
}

#[cfg(not(windows))]
pub fn run_task() -> Result<String, String> {
    Err("非 Windows 上没有计划任务".to_string())
}

#[cfg(not(windows))]
pub fn set_task_enabled(_on: bool) -> Result<String, String> {
    Err("非 Windows 上没有计划任务".to_string())
}

#[cfg(not(windows))]
pub fn ensure_task_if_missing(_exe: &Path) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(windows))]
pub fn delete_task() -> Result<String, String> {
    Err("非 Windows 上没有计划任务".to_string())
}

#[cfg(not(windows))]
pub fn create_task(_exe: &Path) -> Result<String, String> {
    Err("非 Windows 上没有计划任务".to_string())
}

#[cfg(test)]
mod tests {
    use super::{parse_task_state, TaskState};

    #[test]
    fn task_state_protocol_preserves_disabled_and_missing() {
        assert_eq!(parse_task_state("Missing\r\n"), Ok(TaskState::Missing));
        assert_eq!(parse_task_state("Enabled"), Ok(TaskState::Enabled));
        assert_eq!(parse_task_state("Disabled\r\n"), Ok(TaskState::Disabled));
    }

    #[test]
    fn task_state_protocol_never_treats_errors_as_missing() {
        for output in ["", "False", "Access denied", "Ready", "Missing\nEnabled"] {
            assert!(parse_task_state(output).is_err(), "{output:?}");
        }
    }
}
