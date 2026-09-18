using System;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// Mock ttyd: /token + WebSocket /ws（按 ttyd 帧协议回显输入）
class MockTtyd {
    static void Main(string[] args) {
        var listener = new HttpListener();
        listener.Prefixes.Add("http://127.0.0.1:7681/");
        listener.Start();
        Console.WriteLine("mock-ttyd listening on 7681");
        while (true) {
            var ctx = listener.GetContext();
            try {
                if (ctx.Request.Url.AbsolutePath == "/token") {
                    var buf = Encoding.UTF8.GetBytes("{\"token\":\"mock-token\"}");
                    ctx.Response.ContentType = "application/json";
                    ctx.Response.ContentLength64 = buf.Length;
                    ctx.Response.OutputStream.Write(buf, 0, buf.Length);
                    ctx.Response.OutputStream.Close();
                } else if (ctx.Request.IsWebSocketRequest) {
                    var wsCtx = ctx.AcceptWebSocketAsync(null).Result;
                    var ws = wsCtx.WebSocket;
                    Task.Run(async () => {
                        try {
                            // ttyd 协议：首字节 '0' = 终端输出
                            var hello = Encoding.UTF8.GetBytes("0mock-ttyd shell ready\r\n$ ");
                            await ws.SendAsync(new ArraySegment<byte>(hello), WebSocketMessageType.Binary, true, CancellationToken.None);
                            var buf = new byte[4096];
                            while (ws.State == WebSocketState.Open) {
                                var r = await ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None);
                                if (r.MessageType == WebSocketMessageType.Close) {
                                    await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None);
                                    break;
                                }
                                if (r.Count > 1) {
                                    var outBuf = new byte[r.Count];
                                    outBuf[0] = (byte)'0';
                                    Array.Copy(buf, 1, outBuf, 1, r.Count - 1);
                                    await ws.SendAsync(new ArraySegment<byte>(outBuf), WebSocketMessageType.Binary, true, CancellationToken.None);
                                }
                            }
                        } catch {}
                    });
                } else {
                    ctx.Response.StatusCode = 404;
                    ctx.Response.OutputStream.Close();
                }
            } catch {}
        }
    }
}
