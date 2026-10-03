using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace FantasyHub.GameBar.Bridge
{
    internal static class Loopback
    {
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        private static JavaScriptSerializer Json() => new JavaScriptSerializer { MaxJsonLength = 1048576, RecursionLimit = 24 };
        internal static string Error(string id, string error) => Json().Serialize(new { id, ok = false, error });

        [DllImport("shell32.dll")]
        private static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);

        private static string DiscoveryPath()
        {
            // 打包桌面进程不能依赖可能被重定向的 APPDATA。
            var folder = new Guid("3EB685DB-65F9-4CF6-A03A-E3EF65729F3D");
            IntPtr path;
            int result = SHGetKnownFolderPath(ref folder, 0x00010000, IntPtr.Zero, out path);
            if (result != 0) Marshal.ThrowExceptionForHR(result);
            try { return Path.Combine(Marshal.PtrToStringUni(path), "handheld-launcher", "widget-ipc.json"); }
            finally { Marshal.FreeCoTaskMem(path); }
        }

        private static Dictionary<string, object> Object(string text)
        {
            var value = Json().DeserializeObject(text) as Dictionary<string, object>;
            if (value == null) throw new InvalidDataException("Expected JSON object.");
            return value;
        }
        private static string Text(Dictionary<string, object> obj, string key)
        {
            object value;
            return obj.TryGetValue(key, out value) ? value as string : null;
        }
        private static int Integer(Dictionary<string, object> obj, string key)
        {
            object value;
            if (!obj.TryGetValue(key, out value) || !(value is int)) throw new InvalidDataException("Invalid integer: " + key);
            return (int)value;
        }

        internal static async Task<string> SendAsync(string input, CancellationToken cancellation)
        {
            string id = null;
            string token = null;
            try
            {
                if (input == null || Utf8.GetByteCount(input) > 4096) throw new InvalidDataException("Request exceeds 4096 bytes.");
                var request = Object(input);
                id = Text(request, "id");
                if (string.IsNullOrEmpty(id) || id.Length > 64 || Integer(request, "proto") != 1)
                    throw new InvalidDataException("Invalid request identity.");
                string cmd = Text(request, "cmd");
                string extra = cmd == "set_tdp" ? "watts" : cmd == "quit_game" ? "gameId" : cmd == "set_locale" ? "locale" : null;
                if (cmd != "status" && extra == null) throw new InvalidDataException("Command not allowed.");
                if (request.Keys.Any(k => k != "id" && k != "proto" && k != "cmd" && k != extra))
                    throw new InvalidDataException("Unexpected request field.");
                if (cmd == "set_tdp" && (Integer(request, "watts") < 1 || Integer(request, "watts") > 1000))
                    throw new InvalidDataException("Invalid watts.");
                if (cmd == "quit_game" && (string.IsNullOrWhiteSpace(Text(request, "gameId")) || Text(request, "gameId").Length > 512))
                    throw new InvalidDataException("Invalid game identifier.");
                if (cmd == "set_locale" && Text(request, "locale") != "zh-CN" && Text(request, "locale") != "en-US")
                    throw new InvalidDataException("Invalid locale.");

                using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
                {
                    deadline.CancelAfter(TimeSpan.FromSeconds(8));
                    Dictionary<string, object> discovery;
                    using (var file = new FileStream(DiscoveryPath(), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    {
                        var bytes = new byte[8193];
                        int count = 0, read;
                        while (count < bytes.Length && (read = file.Read(bytes, count, bytes.Length - count)) > 0)
                        {
                            deadline.Token.ThrowIfCancellationRequested();
                            count += read;
                        }
                        if (count > 8192) throw new InvalidDataException("Discovery file too large.");
                        discovery = Object(Utf8.GetString(bytes, 0, count));
                    }
                    int port = Integer(discovery, "port");
                    token = Text(discovery, "token");
                    if (Integer(discovery, "proto") != 1 || port < 1 || port > 65535 ||
                        string.IsNullOrEmpty(token) || token.Length > 512 || Integer(discovery, "pid") < 1 || Text(discovery, "version") == null)
                        throw new InvalidDataException("Invalid discovery file.");
                    request["token"] = token;
                    byte[] outgoing = Utf8.GetBytes(Json().Serialize(request) + "\n");
                    if (outgoing.Length > 4096) throw new InvalidDataException("Authenticated request too large.");
                    using (var client = new TcpClient(AddressFamily.InterNetwork))
                    using (deadline.Token.Register(() => client.Close()))
                    {
                        await client.ConnectAsync(IPAddress.Loopback, port);
                        deadline.Token.ThrowIfCancellationRequested();
                        using (NetworkStream stream = client.GetStream())
                        {
                            await stream.WriteAsync(outgoing, 0, outgoing.Length, deadline.Token);
                            using (var received = new MemoryStream())
                            {
                                var buffer = new byte[4096];
                                bool complete = false;
                                while (!complete)
                                {
                                    int read = await stream.ReadAsync(buffer, 0, buffer.Length, deadline.Token);
                                    if (read == 0) throw new IOException("Backend closed before response delimiter.");
                                    int newline = Array.IndexOf(buffer, (byte)'\n', 0, read);
                                    int length = newline < 0 ? read : newline;
                                    if (received.Length + length > 1048576) throw new InvalidDataException("Backend response too large.");
                                    received.Write(buffer, 0, length);
                                    complete = newline >= 0;
                                }
                                var response = Object(Utf8.GetString(received.ToArray()));
                                if (Text(response, "id") != id || !response.ContainsKey("ok") || !(response["ok"] is bool))
                                    throw new InvalidDataException("Backend response identity mismatch.");
                                // 只转发协议字段；令牌不能通过响应或后端错误返回 UWP。
                                var safe = new Dictionary<string, object> { ["id"] = id, ["ok"] = response["ok"] };
                                if (response.ContainsKey("data")) safe["data"] = Scrub(response["data"], token);
                                if (response.ContainsKey("error")) safe["error"] = Scrub(response["error"], token);
                                string output = Json().Serialize(safe);
                                // AppService 的 ValueSet 上限比 TCP 小，不将超限数据交给 WinRT。
                                if (Encoding.Unicode.GetByteCount(output) > 48000)
                                    return Error(id, "Backend response exceeds AppService payload limit.");
                                return output;
                            }
                        }
                    }
                }
            }
            catch (FileNotFoundException) { return Error(id, "Launcher discovery missing. Start FantasyHub first."); }
            catch (DirectoryNotFoundException) { return Error(id, "Launcher discovery missing. Start FantasyHub first."); }
            catch (OperationCanceledException) { return Error(id, "Backend request timed out; result may be unknown. Refresh status."); }
            catch (SocketException) { return Error(id, "Loopback connection failed or was interrupted; result may be unknown. Refresh status."); }
            catch (ObjectDisposedException) { return Error(id, "Backend request canceled; result may be unknown. Refresh status."); }
            catch (InvalidDataException e) { return Error(id, string.IsNullOrEmpty(token) ? e.Message : e.Message.Replace(token, "[redacted]")); }
            catch { return Error(id, "Backend protocol or transport error; result may be unknown. Refresh status."); }
        }

        private static object Scrub(object value, string token)
        {
            if (value is string) return ((string)value).Replace(token, "[redacted]");
            var obj = value as Dictionary<string, object>;
            if (obj != null)
            {
                var safe = new Dictionary<string, object>();
                foreach (var pair in obj)
                    if (!pair.Key.Equals("token", StringComparison.OrdinalIgnoreCase))
                        safe[pair.Key.Replace(token, "[redacted]")] = Scrub(pair.Value, token);
                return safe;
            }
            var array = value as object[];
            return array == null ? value : array.Select(v => Scrub(v, token)).ToArray();
        }
    }
}