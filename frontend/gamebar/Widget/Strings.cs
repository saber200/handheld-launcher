using Windows.Storage;

namespace FantasyHub.GameBar
{
    internal sealed class Strings
    {
        internal string Locale { get; private set; }
        internal bool English => Locale == "en-US";
        internal Strings()
        {
            Locale = ApplicationData.Current.LocalSettings.Values["locale"] as string ?? "zh-CN";
        }
        internal void SetLocale(string locale)
        {
            Locale = locale == "en-US" ? "en-US" : "zh-CN";
            ApplicationData.Current.LocalSettings.Values["locale"] = Locale;
        }
        internal string Pick(string zh, string en) => English ? en : zh;
        internal string Loading => Pick("正在读取驱动与设备状态…", "Reading driver and device status…");
        internal string Refresh => Pick("刷新", "Refresh");
        internal string Close => Pick("关闭小组件", "Close widget");
        internal string Unknown => Pick("未知", "Unknown");
        internal string DriverHelp => Pick("驱动安装或修复请到启动器的管理员工具箱；小组件不会安装内核驱动。", "Install or repair the driver in the launcher's administrator toolbox. This widget never installs kernel drivers.");
        internal string Saved => Pick("已应用", "Applied");
        internal string Failed => Pick("操作失败：", "Operation failed: ");
        internal string Quit => Pick("退出所选运行游戏", "Quit selected running game");
        internal string NoGames => Pick("当前没有运行中的库内游戏", "No library games are running");
        internal string Startup => Pick("请求禁用启动器自启", "Request launcher autostart off");
        internal string StartupHint => Pick("已在小组件本地记录意图；当前通信协议不支持更改启动器自启，请到启动器设置关闭。", "Intent saved locally only. This protocol cannot change launcher autostart; turn it off in launcher settings.");
        internal string Help => Pick("方向键 / 左摇杆导航 · A 确认 · B / Esc 关闭 · Win+G 打开 Game Bar", "D-pad / left stick navigate · A confirm · B / Esc close · Win+G opens Game Bar");
        internal string LaunchHelp => Pick("这是 Xbox Game Bar 原生小组件，不是置顶桌面窗口。\n\n请先启动 FantasyHub，然后按 Win+G，在小组件菜单中选择 FantasyHub，可按需固定。\n\n普通启动仅显示说明，不自动打开控制面板。Back+Start 由启动器侧识别并定向唤起本小组件；需要启动器完成对应集成，小组件不监听全局手柄组合键。", "This is a native Xbox Game Bar widget, not an always-on-top desktop window.\n\nStart FantasyHub, press Win+G and choose FantasyHub from the widget menu. Pin it if desired.\n\nNormal launch only shows this guide. Back+Start is handled by the launcher to target this widget and requires launcher integration. The widget does not monitor global gamepad shortcuts.");
    }
}