using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.Gaming.XboxGameBar;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.ApplicationModel.AppService;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace FantasyHub.GameBar
{
    sealed partial class App : Application
    {
        internal static readonly BridgeConnection Bridge = new BridgeConnection();
        private readonly object sync = new object();
        private readonly Dictionary<Window, WidgetPage> pages = new Dictionary<Window, WidgetPage>();

        public App()
        {
            InitializeComponent();
            Suspending += OnSuspending;
            Resuming += (s, e) => Bridge.Resume();
        }

        protected override void OnBackgroundActivated(BackgroundActivatedEventArgs args)
        {
            base.OnBackgroundActivated(args);
            var details = args.TaskInstance.TriggerDetails as AppServiceTriggerDetails;
            if (details != null) Bridge.Accept(args.TaskInstance, details);
        }

        protected override void OnActivated(IActivatedEventArgs args)
        {
            var protocol = args as IProtocolActivatedEventArgs;
            var activation = args as XboxGameBarWidgetActivatedEventArgs;
            if (args.Kind != ActivationKind.Protocol || protocol?.Uri.Scheme != "ms-gamebarwidget" || activation == null)
                return;
            if (activation.AppExtensionId != "FantasyHubWidget" || !activation.IsLaunchActivation) return;
            Bridge.Resume();
            var window = Window.Current;
            var frame = new Frame();
            window.Content = frame;
            // 每次首次激活都有独立 CoreWindow，页面持续持有对应 SDK 对象。
            var widget = new XboxGameBarWidget(activation, window.CoreWindow, frame);
            frame.Navigate(typeof(WidgetPage), widget);
            var page = (WidgetPage)frame.Content;
            lock (sync) pages[window] = page;
            window.Closed += OnWindowClosed;
            window.Activate();
        }

        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            if (args.PrelaunchActivated) return;
            var frame = Window.Current.Content as Frame;
            if (frame == null) Window.Current.Content = frame = new Frame();
            if (frame.Content == null) frame.Navigate(typeof(LaunchPage));
            Window.Current.Activate();
        }

        private async void OnWindowClosed(object sender, Windows.UI.Core.CoreWindowEventArgs args)
        {
            var window = Window.Current;
            window.Closed -= OnWindowClosed;
            WidgetPage page;
            lock (sync)
            {
                if (!pages.TryGetValue(window, out page)) return;
                pages.Remove(window);
            }
            try { await page.ShutdownAsync(); }
            finally
            {
                lock (sync) if (pages.Count == 0) Bridge.Stop();
            }
        }

        private async void OnSuspending(object sender, SuspendingEventArgs args)
        {
            var deferral = args.SuspendingOperation.GetDeferral();
            try
            {
                WidgetPage[] snapshot;
                lock (sync) { snapshot = pages.Values.ToArray(); pages.Clear(); }
                var cleanup = snapshot.Select(ShutdownOnDispatcherAsync).ToArray();
                // 系统暂停期限有限，最佳努力提交不能阻塞 deferral 无限等待。
                await Task.WhenAny(Task.WhenAll(cleanup), Task.Delay(1200));
            }
            finally { Bridge.Stop(); deferral.Complete(); }
        }

        private static async Task ShutdownOnDispatcherAsync(WidgetPage page)
        {
            try
            {
                if (page.Dispatcher.HasThreadAccess) { await page.ShutdownAsync(); return; }
                var done = new TaskCompletionSource<bool>();
                await page.Dispatcher.RunAsync(Windows.UI.Core.CoreDispatcherPriority.Normal, async () =>
                {
                    try { await page.ShutdownAsync(); }
                    finally { done.TrySetResult(true); }
                });
                await done.Task;
            }
            catch { /* CoreWindow 已销毁时仍由 Bridge.Stop 取消传输。 */ }
        }
    }
}