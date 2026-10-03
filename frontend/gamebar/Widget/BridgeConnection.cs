using System;
using System.Threading;
using System.Threading.Tasks;
using Windows.ApplicationModel;
using Windows.ApplicationModel.AppService;
using Windows.ApplicationModel.Background;
using Windows.Data.Json;
using Windows.Foundation.Collections;

namespace FantasyHub.GameBar
{
    internal sealed class BridgeConnection
    {
        internal const string ServiceName = "FantasyHub.WidgetBridge";
        private readonly object sync = new object();
        private readonly SemaphoreSlim serial = new SemaphoreSlim(1, 1);
        private TaskCompletionSource<Session> ready = NewReady();
        private Session session;
        private DateTime lastLaunch = DateTime.MinValue;
        private int queued;
        private bool stopped;

        private static TaskCompletionSource<Session> NewReady() =>
            new TaskCompletionSource<Session>(TaskCreationOptions.RunContinuationsAsynchronously);

        private sealed class Session : IDisposable
        {
            internal AppServiceConnection Connection;
            internal BackgroundTaskDeferral Deferral;
            internal IBackgroundTaskInstance Task;
            internal readonly CancellationTokenSource Closed = new CancellationTokenSource();
            internal Windows.Foundation.TypedEventHandler<AppServiceConnection, AppServiceClosedEventArgs> OnClosed;
            internal BackgroundTaskCanceledEventHandler OnCanceled;
            private int disposed;
            public void Dispose()
            {
                if (Interlocked.Exchange(ref disposed, 1) != 0) return;
                // Each cleanup is independent: an already-closed WinRT object must not
                // prevent cancellation, other unsubscriptions or the background deferral.
                try { Closed.Cancel(); } catch { }
                try { Connection.ServiceClosed -= OnClosed; } catch { }
                try { Task.Canceled -= OnCanceled; } catch { }
                try { Connection.Dispose(); } catch { }
                try { Deferral.Complete(); } catch { }
            }
        }

        internal void Resume() { lock (sync) stopped = false; }

        internal void Accept(IBackgroundTaskInstance task, AppServiceTriggerDetails details)
        {
            BackgroundTaskDeferral deferral = null;
            AppServiceConnection connection = null;
            Session next = null;
            try
            {
                deferral = task.GetDeferral();
                connection = details.AppServiceConnection;
                if (details.Name != ServiceName ||
                    details.CallerPackageFamilyName != Package.Current.Id.FamilyName)
                    return;
                next = new Session { Connection = connection, Deferral = deferral, Task = task };
                // Ownership passes to Session, including all failure paths below.
                connection = null;
                deferral = null;
                next.OnClosed = (s, e) => Drop(next);
                next.OnCanceled = (s, e) => Drop(next);
                lock (sync)
                {
                    // A duplicate full-trust launch must never displace the live connection.
                    if (stopped || session != null)
                    {
                        next.Dispose();
                        return;
                    }
                    session = next;
                    next.Connection.ServiceClosed += next.OnClosed;
                    task.Canceled += next.OnCanceled;
                    if (ReferenceEquals(session, next)) ready.TrySetResult(next);
                }
            }
            catch { if (next != null) Drop(next); }
            finally
            {
                try { connection?.Dispose(); } catch { }
                try { deferral?.Complete(); } catch { }
            }
        }

        private void Drop(Session old)
        {
            lock (sync)
            {
                if (ReferenceEquals(session, old))
                {
                    session = null;
                    ready = NewReady();
                }
            }
            old.Dispose();
        }

        internal void Stop()
        {
            Session old;
            lock (sync)
            {
                stopped = true;
                old = session;
                session = null;
                ready.TrySetCanceled();
                ready = NewReady();
            }
            old?.Dispose();
        }

        private async Task<Session> EnsureAsync(CancellationToken cancellation)
        {
            Task<Session> wait;
            bool launch;
            lock (sync)
            {
                if (stopped) throw new OperationCanceledException();
                if (session != null) return session;
                wait = ready.Task;
                launch = DateTime.UtcNow - lastLaunch > TimeSpan.FromSeconds(3);
                if (launch) lastLaunch = DateTime.UtcNow;
            }
            if (launch)
            {
                try { await FullTrustProcessLauncher.LaunchFullTrustProcessForCurrentAppAsync().AsTask(cancellation); }
                catch (OperationCanceledException) { throw; }
                catch (Exception e) { throw new InvalidOperationException("Cannot start packaged bridge: " + e.Message); }
            }
            using (var delay = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
            {
                Task timer = Task.Delay(TimeSpan.FromSeconds(8), delay.Token);
                Task winner = await Task.WhenAny(wait, timer);
                cancellation.ThrowIfCancellationRequested();
                if (winner != wait) throw new TimeoutException("Bridge cold start timed out. Refresh to reconnect.");
                delay.Cancel();
                return await wait;
            }
        }

        internal async Task<JsonObject> SendAsync(string command, CancellationToken cancellation, string field = null, IJsonValue value = null)
        {
            if (Interlocked.Increment(ref queued) > 8)
            {
                Interlocked.Decrement(ref queued);
                throw new InvalidOperationException("Bridge busy. Refresh later.");
            }
            bool entered = false;
            Session current = null;
            using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
            {
                deadline.CancelAfter(TimeSpan.FromSeconds(22));
                try
                {
                    await serial.WaitAsync(deadline.Token);
                    entered = true;
                    current = await EnsureAsync(deadline.Token);
                    string id = Guid.NewGuid().ToString("N");
                    var request = new JsonObject
                    {
                        ["proto"] = JsonValue.CreateNumberValue(1),
                        ["id"] = JsonValue.CreateStringValue(id),
                        ["cmd"] = JsonValue.CreateStringValue(command)
                    };
                    if (field != null) request[field] = value;
                    using (var transport = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token, current.Closed.Token))
                    {
                        transport.CancelAfter(TimeSpan.FromSeconds(12));
                        var result = await current.Connection.SendMessageAsync(new ValueSet { ["request"] = request.Stringify() }).AsTask(transport.Token);
                        if (result.Status != AppServiceResponseStatus.Success)
                        {
                            Drop(current);
                            throw new InvalidOperationException("AppService disconnected; result may be unknown. Refresh status.");
                        }
                        object raw;
                        if (result.Message.Count != 1 || !result.Message.TryGetValue("response", out raw) || !(raw is string) || ((string)raw).Length > 24000)
                        {
                            Drop(current);
                            throw new InvalidOperationException("Invalid bridge response.");
                        }
                        JsonObject response = JsonObject.Parse((string)raw);
                        string responseId = Models.Text(response, "id");
                        if (responseId != id)
                            throw new InvalidOperationException(Models.Text(response, "error", "Bridge response identity mismatch."));
                        if (!Models.Bool(response, "ok"))
                            throw new InvalidOperationException(Models.Text(response, "error", "Backend request failed."));
                        return response;
                    }
                }
                catch (OperationCanceledException)
                {
                    // SendMessageAsync 取消不代表服务端未执行；不重放有副作用的请求。
                    if (current != null) Drop(current);
                    if (cancellation.IsCancellationRequested) throw;
                    throw new TimeoutException("Bridge request timed out; result may be unknown. Refresh status.");
                }
                finally
                {
                    if (entered) serial.Release();
                    Interlocked.Decrement(ref queued);
                }
            }
        }
    }
}