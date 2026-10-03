using System;
using System.Threading;
using System.Threading.Tasks;
using Windows.ApplicationModel;
using Windows.ApplicationModel.AppService;
using Windows.Foundation.Collections;

namespace FantasyHub.GameBar.Bridge
{
    internal static class Program
    {
        private static readonly SemaphoreSlim Serial = new SemaphoreSlim(1, 1);
        private static int queued;

        [STAThread]
        private static void Main()
        {
            // Mutex 必须由同一线程获取并释放；异步 continuation 不拥有它。
            using (var singleton = new Mutex(false, @"Local\FantasyHub.GameBar.Bridge." + Package.Current.Id.FamilyName))
            {
                bool owns;
                try { owns = singleton.WaitOne(0); }
                catch (AbandonedMutexException) { owns = true; }
                if (!owns) return;
                // Run WinRT connection work on the MTA pool; this STA entry thread
                // has no messagepump while it waits and must only own the mutex.
                try { Task.Run(RunAsync).GetAwaiter().GetResult(); }
                catch { /* 不写日志，避免发现文件中的认证信息落盘。 */ }
                finally { singleton.ReleaseMutex(); }
            }
        }

        private static async Task RunAsync()
        {
            // 断线后短时重连，避免无限后台激活 UWP；以后由小组件再次按需拉起。
            DateTime retryUntil = DateTime.UtcNow.AddSeconds(20);
            while (DateTime.UtcNow < retryUntil)
            {
                using (var lifetime = new CancellationTokenSource())
                using (var connection = new AppServiceConnection
                {
                    AppServiceName = "FantasyHub.WidgetBridge",
                    PackageFamilyName = Package.Current.Id.FamilyName
                })
                {
                    int served = 0;
                    var activity = new object();
                    var idle = System.Diagnostics.Stopwatch.StartNew();
                    int active = 0;
                    bool retiring = false;
                    // Capture before registering callbacks: the source may be disposed while
                    // an already-delivered RequestReceived callback is finishing.
                    var connectionToken = lifetime.Token;
                    var closed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                    connection.ServiceClosed += (s, e) =>
                    {
                        lock (activity) retiring = true;
                        try { lifetime.Cancel(); } catch (ObjectDisposedException) { }
                        closed.TrySetResult(true);
                    };
                    connection.RequestReceived += async (s, e) =>
                    {
                        Windows.ApplicationModel.AppService.AppServiceDeferral deferral;
                        try { deferral = e.GetDeferral(); } catch { return; }
                        lock (activity)
                        {
                            if (retiring)
                            {
                                try { deferral.Complete(); } catch { }
                                return;
                            }
                            active++;
                            idle.Restart();
                        }
                        bool entered = false;
                        int count = Interlocked.Increment(ref queued);
                        try
                        {
                            string response;
                            if (count > 8)
                                response = Loopback.Error(null, "Bridge busy; retry status later.");
                            else
                            {
                                using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(connectionToken))
                                {
                                    deadline.CancelAfter(TimeSpan.FromSeconds(10));
                                    await Serial.WaitAsync(deadline.Token);
                                    entered = true;
                                    if (e.Request.Message.Count != 1 ||
                                        !e.Request.Message.ContainsKey("request") ||
                                        !(e.Request.Message["request"] is string))
                                        response = Loopback.Error(null, "Invalid AppService envelope.");
                                    else
                                    {
                                        Interlocked.Exchange(ref served, 1);
                                        response = await Loopback.SendAsync((string)e.Request.Message["request"], deadline.Token);
                                    }
                                }
                            }
                            using (var replyTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(2)))
                                await e.Request.SendResponseAsync(new ValueSet { ["response"] = response }).AsTask(replyTimeout.Token);
                        }
                        catch (OperationCanceledException)
                        {
                            await TryErrorAsync(e, "Bridge request timed out or disconnected; result may be unknown.");
                        }
                        catch
                        {
                            await TryErrorAsync(e, "Bridge transport failed; result may be unknown.");
                        }
                        finally
                        {
                            if (entered) Serial.Release();
                            Interlocked.Decrement(ref queued);
                            lock (activity) { active--; idle.Restart(); }
                            try { deferral.Complete(); } catch { }
                        }
                    };
                    try
                    {
                        using (var openTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
                        {
                            if (await connection.OpenAsync().AsTask(openTimeout.Token) == AppServiceConnectionStatus.Success)
                            {
                                // No widget traffic for 30s: release the AppService deferral
                                // by closing this connection and EXIT, not a reconnect loop.
                                // This also breaks the last-window/background-task lifetime cycle.
                                while (!closed.Task.IsCompleted)
                                {
                                    await Task.WhenAny(closed.Task, Task.Delay(1000));
                                    bool idleExit;
                                    lock (activity)
                                    {
                                        idleExit = !retiring && active == 0 && idle.Elapsed >= TimeSpan.FromSeconds(30);
                                        if (idleExit) retiring = true;
                                    }
                                    if (idleExit) return;
                                }
                                // Rejected background connections can briefly report Success.
                                // Only real widget traffic may renew the bounded retry window.
                                if (Volatile.Read(ref served) != 0) retryUntil = DateTime.UtcNow.AddSeconds(20);
                            }
                        }
                    }
                    catch { }
                    finally
                    {
                        lock (activity) retiring = true;
                        lifetime.Cancel();
                    }
                }
                await Task.Delay(500);
            }
        }

        private static async Task TryErrorAsync(AppServiceRequestReceivedEventArgs e, string error)
        {
            try
            {
                using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1)))
                    await e.Request.SendResponseAsync(new ValueSet { ["response"] = Loopback.Error(null, error) }).AsTask(timeout.Token);
            }
            catch { }
        }
    }
}