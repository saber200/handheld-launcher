using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Gaming.XboxGameBar;
using Windows.Data.Json;
using Windows.Storage;
using Windows.System;
using Windows.UI.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Controls.Primitives;
using Windows.UI.Xaml.Input;
using Windows.UI.Xaml.Navigation;

namespace FantasyHub.GameBar
{
    public sealed partial class WidgetPage : Page
    {
        private readonly Strings text = new Strings();
        private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        private readonly DispatcherTimer writeTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(260) };
        private readonly DispatcherTimer refreshTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        private XboxGameBarWidget widget;
        private Window window;
        private TdpInfo info;
        private JsonObject status;
        private readonly List<ToggleButton> presetButtons = new List<ToggleButton>();
        private readonly List<int> presetWatts = new List<int>();
        private bool presetsEnabled;
        private int? pending;
        private int draft = 5;
        private long revision;
        private bool updating, refreshing, quitting, closing, initialized;
        private Task writing = Task.CompletedTask;
        private Task shutdown;

        public WidgetPage()
        {
            InitializeComponent();
            writeTimer.Tick += WriteTick;
            refreshTimer.Tick += RefreshTick;
            Loaded += PageLoaded;
            Unloaded += PageUnloaded;
            AddHandler(KeyDownEvent, new KeyEventHandler(PageKeyDown), false);
            TdpSlider.AddHandler(PointerReleasedEvent, new PointerEventHandler(SliderReleased), true);
            TdpSlider.AddHandler(PointerCaptureLostEvent, new PointerEventHandler(SliderReleased), true);
            TdpSlider.LostFocus += SliderLostFocus;
            Sound.MediaOpened += SoundOpened;
            Sound.MediaFailed += SoundFailed;
            TdpSlider.AddHandler(KeyDownEvent, new KeyEventHandler(SliderKeyDown), true);
            TdpSlider.AddHandler(KeyUpEvent, new KeyEventHandler(SliderKeyUp), true);
            ApplyLanguage();
            initialized = true;
        }

        protected override void OnNavigatedTo(NavigationEventArgs e)
        {
            base.OnNavigatedTo(e);
            widget = e.Parameter as XboxGameBarWidget;
            window = Window.Current;
            window.Activated += WindowActivated;
            window.VisibilityChanged += WindowVisibilityChanged;
        }

        private async void PageLoaded(object sender, RoutedEventArgs e)
        {
            if (closing) return;
            RefreshButton.Focus(FocusState.Programmatic);
            await RefreshAsync();
            if (!closing) refreshTimer.Start();
        }
        private async void PageUnloaded(object sender, RoutedEventArgs e) { await ShutdownAsync(); }
        private async void RefreshTick(object sender, object e)
        {
            if (!closing && window != null && window.Visible && pending == null && writing.IsCompleted)
                await RefreshAsync();
        }
        private async void WriteTick(object sender, object e) { await FlushAsync(); }
        private async void SliderReleased(object sender, PointerRoutedEventArgs e) { await FlushAsync(); }
        private async void SliderLostFocus(object sender, RoutedEventArgs e) { await FlushAsync(); }
        private async void WindowActivated(object sender, WindowActivatedEventArgs e)
        {
            if (closing) return;
            if (e.WindowActivationState == CoreWindowActivationState.Deactivated) await FlushAsync();
            else await RefreshAsync();
        }
        private async void WindowVisibilityChanged(object sender, VisibilityChangedEventArgs e)
        {
            if (closing) return;
            if (!e.Visible) await FlushAsync();
            else await RefreshAsync();
        }

        private void ApplyLanguage()
        {
            updating = true;
            LanguageBox.SelectedIndex = text.English ? 1 : 0;
            updating = false;
            RefreshButton.Content = text.Refresh;
            CloseButton.Content = text.Close;
            PowerTitle.Text = text.Pick("功耗 / TDP", "Power / TDP");
            DriverHelpText.Text = text.DriverHelp;
            FanButton.Content = text.Pick("风扇控制 · 暂未开放", "Fan control · Coming later");
            QuitButton.Content = text.Quit;
            StartupButton.Content = text.Startup;
            HelpText.Text = text.Help;
            TdpSlider.Header = text.Pick("调整功耗（瓦）", "Adjust power (watts)");
            StartupText.Text = ApplicationData.Current.LocalSettings.Values.ContainsKey("disableAutostartRequested")
                ? text.StartupHint : text.Pick("仅记录意图；实际自启开关请在启动器设置中关闭。", "Intent only; change actual autostart in launcher settings.");
            if (queryError != null) RenderQueryError();
            else if (status != null) RenderStatus(false);
        }

        private Task refreshOperation = Task.CompletedTask;
        private bool statusAvailable;
        private string queryError;
        private async Task RefreshAsync(bool afterMutation = false)
        {
            if (afterMutation)
            {
                await refreshOperation;
                await FlushAsync();
                statusAvailable = false;
            }
            if (closing || refreshing || (quitting && !afterMutation) || pending != null || !writing.IsCompleted) return;
            refreshOperation = RefreshCoreAsync();
            await refreshOperation;
        }

        private async Task RefreshCoreAsync()
        {
            refreshing = true;
            RefreshButton.IsEnabled = false;
            long requestedRevision = revision;
            long requestedLocaleRevision = localeRevision;
            if (status == null) DriverText.Text = text.Loading;
            try
            {
                var response = await App.Bridge.SendAsync("status", lifetime.Token);
                if (closing || revision != requestedRevision || pending != null || !writing.IsCompleted) return;
                var nextStatus = Models.Object(response, "data") ?? throw new InvalidOperationException("Missing status data.");
                Models.Tdp(Models.Object(nextStatus, "tdp")); // Validate before replacing the last usable snapshot.
                status = nextStatus;
                queryError = null;
                statusAvailable = true;
                string locale = Models.Text(status, "locale");
                if (!changingLocale && requestedLocaleRevision == localeRevision && (locale == "zh-CN" || locale == "en-US"))
                    text.SetLocale(locale);
                ApplyLanguage();
                RenderStatus(revision == requestedRevision && pending == null && writing.IsCompleted);
            }
            catch (OperationCanceledException) { }
            catch (Exception e)
            {
                if (!closing)
                {
                    statusAvailable = false;
                    TdpSlider.IsEnabled = QuitButton.IsEnabled = false;
                    SetPresetsEnabled(false);
                    queryError = e.Message;
                    RenderQueryError();
                }
            }
            finally { refreshing = false; if (!closing) RefreshButton.IsEnabled = true; }
        }

        private void RenderQueryError()
        {
            TdpSlider.IsEnabled = QuitButton.IsEnabled = false;
            SetPresetsEnabled(false);
            StatusText.Text = text.Failed + queryError;
            DriverText.Text = text.Pick("无法读取驱动状态", "Unable to read driver status");
        }

        private void RenderStatus(bool updateDraft)
        {
            // Language changes and mutation cleanup must not resurrect a stale snapshot.
            if (queryError != null) { RenderQueryError(); return; }
            var driver = Models.Object(status, "driver");
            string driverError = Models.Text(status, "driverError");
            string tdpError = Models.Text(status, "tdpError");
            bool ready = Models.Bool(driver, "ready") && driverError.Length == 0;
            DriverText.Text = driverError.Length > 0 ? text.Pick("驱动查询失败：", "Driver query failed: ") + driverError
                : driver == null ? text.Pick("驱动状态未知", "Driver status unknown")
                : (ready ? text.Pick("驱动已就绪", "Driver ready")
                    : Models.Bool(driver, "installed") ? text.Pick("驱动未就绪", "Driver not ready")
                    : text.Pick("驱动未安装", "Driver not installed")) + " · " + Models.Text(driver, "message");
            info = Models.Tdp(Models.Object(status, "tdp"));
            bool enabled = statusAvailable && ready && info != null && info.Supported && tdpError.Length == 0;
            bool usable = enabled && !closing && !quitting;
            TdpSlider.IsEnabled = usable;
            SetPresetsEnabled(usable);
            // 原前端 .tdp-cpu 只显示 CPU 名。真机上之前那串「Intel(R) Arc(TM) G3 Extreme · intel · intel-msr」
            // 一眼就不是原版的样子 —— vendor / backend 是内部字段，只在拿不到 CPU 名时回退去显示，避免这行变空。
            DeviceText.Text = info == null ? "" : info.Cpu.Length > 0 ? info.Cpu : info.Vendor + " · " + info.Backend;
            if (info != null)
            {
                updating = true;
                // Expand first so switching between disjoint device ranges cannot coerce a bound.
                TdpSlider.Maximum = Math.Max(TdpSlider.Maximum, info.Max);
                TdpSlider.Minimum = info.Min;
                TdpSlider.Maximum = info.Max;
                SyncPresets(info.Presets);
                if (updateDraft) draft = Clamp(info.Watts ?? info.Min);
                TdpSlider.Value = Clamp(draft);
                SetPresetOn(Clamp(draft));
                WattsText.Text = (info.Watts.HasValue || revision > 0) ? Clamp(draft) + " W" : "— W";
                RangeText.Text = info.Min + " – " + info.Max + " W";
                updating = false;
            }
            if (tdpError.Length > 0) StatusText.Text = text.Pick("TDP 查询失败：", "TDP query failed: ") + tdpError;
            else if (info != null && updateDraft) StatusText.Text = info.Message;
            RenderGames();
        }

        private int Clamp(int watts) { return Math.Max(info?.Min ?? 5, Math.Min(info?.Max ?? 40, watts)); }

        // 预设按钮由代码生成（原因见 XAML 里 PresetGrid 那段注释：GridView 的 ItemsWrapGrid
        // 按「最宽那项的期望宽度」铺，按钮撑不满列、字还被裁）。3 列固定、列宽 = *，行按需加。
        // 只有取值序列真的变了才重建 —— 每 5 秒轮询重建会把焦点和选中态推倒重来。
        private void SyncPresets(List<int> presets)
        {
            bool same = presets.Count == presetWatts.Count;
            if (same)
                for (int i = 0; i < presets.Count; i++)
                    if (presetWatts[i] != presets[i]) { same = false; break; }
            if (same) return;
            presetButtons.Clear();
            presetWatts.Clear();
            PresetGrid.Children.Clear();
            PresetGrid.ColumnDefinitions.Clear();
            PresetGrid.RowDefinitions.Clear();
            for (int column = 0; column < 3; column++)
                PresetGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            for (int index = 0; index < presets.Count; index++)
            {
                if (index % 3 == 0) PresetGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                var button = new ToggleButton
                {
                    Content = presets[index] + "W",
                    Tag = presets[index],
                    Style = (Style)Resources["FhPresetStyle"],
                    IsEnabled = presetsEnabled,
                    // 中间两列右侧留 10 的缝；最后一列不留，否则右边缘会多一条空白。
                    Margin = new Thickness(0, 0, index % 3 == 2 ? 0 : 10, 10),
                };
                button.Click += PresetToggleClick;
                Grid.SetRow(button, index / 3);
                Grid.SetColumn(button, index % 3);
                PresetGrid.Children.Add(button);
                presetButtons.Add(button);
                presetWatts.Add(presets[index]);
            }
        }

        // 直接写按钮状态，不走绑定：值没变也要写 —— 连点同一个预设时 ToggleButton
        // 已经把自己翻成 unchecked，不写回去就会显示成「没选中」。
        private void SetPresetOn(int watts)
        {
            for (int i = 0; i < presetButtons.Count; i++)
                presetButtons[i].IsChecked = presetWatts[i] == watts;
        }

        // 原前端 .tdp-preset:disabled 是 opacity .45，容器不继承，得自己设。
        // Grid 是 Panel，没有 IsEnabled（UWP 把它放在 Control 上，只有 WPF 放在 UIElement）——
        // 所以「能不能点」逐个落到 ToggleButton，外层 Grid 只负责整体变暗。
        // 记一份状态：按钮是 SyncPresets 里建的，建的时候要照着当前状态初始化。
        private void SetPresetsEnabled(bool enabled)
        {
            presetsEnabled = enabled;
            PresetGrid.Opacity = enabled ? 1 : 0.45;
            foreach (ToggleButton button in presetButtons) button.IsEnabled = enabled;
        }

        private void RenderGames()
        {
            string selected = (GamesBox.SelectedItem as RunningGame)?.Id;
            var games = new List<RunningGame>();
            IJsonValue value;
            if (status.TryGetValue("games", out value) && value.ValueType == JsonValueType.Array)
                foreach (var item in value.GetArray())
                {
                    if (item.ValueType != JsonValueType.Object) continue;
                    var game = item.GetObject();
                    string id = Models.Text(game, "id");
                    if (id.Length > 0) games.Add(new RunningGame { Id = id, Name = Models.Text(game, "name") });
                }
            GamesBox.ItemsSource = games;
            GamesBox.SelectedItem = games.Find(g => g.Id == selected) ?? (games.Count > 0 ? games[0] : null);
            GamesText.Text = games.Count == 0 ? text.NoGames : text.Pick("运行中的游戏", "Running games");
            QuitButton.IsEnabled = statusAvailable && games.Count > 0 && !quitting && !closing;
        }

        private void QueueTdp(int watts, bool immediate)
        {
            if (closing || !TdpSlider.IsEnabled) return;
            draft = Clamp(watts);
            pending = draft;
            revision++;
            updating = true;
            TdpSlider.Value = draft;
            SetPresetOn(draft);
            WattsText.Text = draft + " W";
            updating = false;
            if (immediate) { _ = FlushAsync(); }
            else if (!writeTimer.IsEnabled) writeTimer.Start();
        }

        private Task FlushAsync()
        {
            writeTimer.Stop();
            if (writing.IsCompleted && pending.HasValue && !lifetime.IsCancellationRequested)
                writing = DrainAsync();
            return writing;
        }

        private async Task DrainAsync()
        {
            // Yield before the first request so writing is assigned before any reentrant UI event.
            await Task.Yield();
            while (pending.HasValue && !lifetime.IsCancellationRequested)
            {
                int watts = Clamp(pending.Value);
                long sentRevision = revision;
                pending = null;
                try
                {
                    var reply = await App.Bridge.SendAsync("set_tdp", lifetime.Token, "watts", JsonValue.CreateNumberValue(watts));
                    if (lifetime.IsCancellationRequested) return;
                    var data = Models.Object(reply, "data");
                    var applied = Models.Tdp(data);
                    if (applied == null || !applied.Supported || !applied.Watts.HasValue)
                        throw new InvalidOperationException("Missing valid TDP write result; outcome unknown.");
                    if (revision == sentRevision)
                    {
                        if (status != null) status["tdp"] = data;
                        info = applied;
                        draft = applied.Watts.Value;
                        if (status != null && !closing) RenderStatus(true);
                        if (!closing) { OperationText.Text = text.Saved + " " + applied.Message; Play("done"); }
                    }
                }
                catch (OperationCanceledException) { return; }
                catch (Exception e)
                {
                    if (!closing) OperationText.Text = text.Failed + e.Message;
                    // Never replay a failed write: it may already have reached the driver.
                }
            }
        }

        private void SliderChanged(object sender, RangeBaseValueChangedEventArgs e)
        {
            if (!initialized || updating || closing) return;
            int next = Clamp((int)Math.Round(e.NewValue));
            if (next == draft) return;
            Play(next > draft ? "tdp-up" : "tdp-down");
            QueueTdp(next, false);
        }

        private void PresetToggleClick(object sender, RoutedEventArgs e)
        {
            // ToggleButton 点下去会自己翻 IsChecked，所以这里只取目标瓦数，
            // 真实状态由 QueueTdp 到 SetPresetOn 写回（值没变也写，连点同一个能复位）。
            var button = sender as ToggleButton;
            if (button == null || !(button.Tag is int) || closing) return;
            Play("click");
            QueueTdp((int)button.Tag, true);
        }

        private async void SliderKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (e.Key == VirtualKey.GamepadA || e.Key == VirtualKey.Enter)
            { e.Handled = true; await FlushAsync(); }
        }

        private async void SliderKeyUp(object sender, KeyRoutedEventArgs e)
        {
            // Native Slider already handled keyboard/gamepad adjustment. Flush its latest value.
            if (pending.HasValue) await FlushAsync();
        }

        private async void PageKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (e.Key == VirtualKey.GamepadB || e.Key == VirtualKey.Escape)
            { e.Handled = true; await CloseAsync(); }
        }

        private async void RefreshClick(object sender, RoutedEventArgs e)
        { Play("click"); await FlushAsync(); await RefreshAsync(); }

        private void SoundOpened(object sender, RoutedEventArgs e)
        {
            try { if (!closing) Sound.Play(); } catch { }
        }
        private void SoundFailed(object sender, ExceptionRoutedEventArgs e) { /* Optional audio. */ }

        private void Play(string name)
        {
            if (closing) return;
            try { Sound.Stop(); Sound.Source = new Uri("ms-appx:///Assets/Sounds/" + name + ".wav"); }
            catch (Exception) { /* Sound is optional, never block a control operation. */ }
        }

        private long localeRevision;
        private bool changingLocale;
        private async void LanguageChanged(object sender, SelectionChangedEventArgs e)
        {
            if (!initialized || updating || closing || changingLocale) return;
            changingLocale = true;
            LanguageBox.IsEnabled = false;
            localeRevision++;
            string locale = LanguageBox.SelectedIndex == 1 ? "en-US" : "zh-CN";
            text.SetLocale(locale);
            ApplyLanguage();
            Play("click");
            try
            {
                await App.Bridge.SendAsync("set_locale", lifetime.Token, "locale", JsonValue.CreateStringValue(locale));
                if (status != null) status["locale"] = JsonValue.CreateStringValue(locale);
            }
            catch (OperationCanceledException) { }
            catch (Exception error) { if (!closing) OperationText.Text = text.Failed + error.Message; }
            finally { changingLocale = false; if (!closing) LanguageBox.IsEnabled = true; }
        }

        private async void QuitClick(object sender, RoutedEventArgs e)
        {
            var game = GamesBox.SelectedItem as RunningGame;
            if (game == null || quitting || closing) return;
            quitting = true;
            QuitButton.IsEnabled = false;
            GamesBox.IsEnabled = false;
            TdpSlider.IsEnabled = false;
            SetPresetsEnabled(false);
            Play("click");
            string result = "";
            try
            {
                try
                {
                    await FlushAsync();
                    var reply = await App.Bridge.SendAsync("quit_game", lifetime.Token, "gameId", JsonValue.CreateStringValue(game.Id));
                    var data = Models.Object(reply, "data");
                    int? killed = Models.Integer(data, "killed");
                    if (!killed.HasValue || killed < 0)
                        throw new InvalidOperationException("Missing valid quit result; outcome unknown.");
                    result = killed == 0 ? text.Pick("未找到仍在运行的游戏进程", "No running game process found")
                        : text.Pick("已结束游戏进程：", "Game processes stopped: ") + killed.Value;
                    Play("done");
                }
                catch (OperationCanceledException) { return; }
                catch (Exception error) { result = text.Failed + error.Message; }
                // Keep controls locked until a fresh status completes, including unknown outcomes.
                // The side effect itself is never retried.
                await RefreshAsync(true);
                if (!closing) OperationText.Text = result;
            }
            finally
            {
                quitting = false;
                if (!closing)
                {
                    GamesBox.IsEnabled = true;
                    if (status != null) RenderStatus(false);
                }
            }
        }

        private void StartupClick(object sender, RoutedEventArgs e)
        {
            if (closing) return;
            Play("click");
            ApplicationData.Current.LocalSettings.Values["disableAutostartRequested"] = true;
            StartupText.Text = text.StartupHint;
        }

        private async void CloseClick(object sender, RoutedEventArgs e) { await CloseAsync(); }
        private async Task CloseAsync()
        {
            if (closing) return;
            var current = widget;
            await ShutdownAsync();
            try { current?.Close(); }
            catch (Exception) { /* Host can close the window while the flush is in progress. */ }
        }

        internal Task ShutdownAsync()
        {
            if (shutdown == null) shutdown = ShutdownCoreAsync();
            return shutdown;
        }

        private async Task ShutdownCoreAsync()
        {
            closing = true;
            refreshTimer.Stop();
            writeTimer.Stop();
            TdpSlider.IsEnabled = QuitButton.IsEnabled = false;
            SetPresetsEnabled(false);
            try { await Task.WhenAny(FlushAsync(), Task.Delay(1000)); }
            finally
            {
                lifetime.Cancel();
                pending = null;
                writeTimer.Tick -= WriteTick;
                refreshTimer.Tick -= RefreshTick;
                Loaded -= PageLoaded;
                Unloaded -= PageUnloaded;
                RemoveHandler(KeyDownEvent, new KeyEventHandler(PageKeyDown));
                TdpSlider.RemoveHandler(PointerReleasedEvent, new PointerEventHandler(SliderReleased));
                TdpSlider.RemoveHandler(PointerCaptureLostEvent, new PointerEventHandler(SliderReleased));
                TdpSlider.LostFocus -= SliderLostFocus;
                TdpSlider.RemoveHandler(KeyDownEvent, new KeyEventHandler(SliderKeyDown));
                TdpSlider.RemoveHandler(KeyUpEvent, new KeyEventHandler(SliderKeyUp));
                Sound.MediaOpened -= SoundOpened;
                Sound.MediaFailed -= SoundFailed;
                if (window != null)
                {
                    window.Activated -= WindowActivated;
                    window.VisibilityChanged -= WindowVisibilityChanged;
                }
                try { Sound.Stop(); Sound.Source = null; } catch { }
                widget = null;
            }
        }
    }
}