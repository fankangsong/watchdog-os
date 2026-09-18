using System;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// Mock ttyd（本地开发/联调用）：
//  - 解析并忽略 server.js 传入的 -i 127.0.0.1 -p 7681 <shell> 参数，固定监听 127.0.0.1:7681
//  - GET /token          返回 {"token":"mock-token"}
//  - WS   /ws            按 ttyd 帧协议工作：输出帧首字节 '0'，回显客户端输入
// 由 server.js 通过 TTYD_PATH 指向本 exe 自动拉起，无需手动运行。
// 注意：server.js 以 stdio:'ignore' spawn 本进程，任何控制台输出/异常都必须吞掉，避免崩溃。
class MockTtyd {
    static void Main(string[] args) {
        try {
            Run();
        } catch {}
    }

    static void Run() {
        var listener = new HttpListener();
        listener.Prefixes.Add("http://127.0.0.1:7681/");
        listener.Start();
        while (true) {
            HttpListenerContext ctx = null;
            try {
                ctx = listener.GetContext();
                if (ctx.Request.Url.AbsolutePath == "/token") {
                    var buf = Encoding.UTF8.GetBytes("{\"token\":\"mock-token\"}");
                    ctx.Response.ContentType = "application/json";
                    ctx.Response.ContentLength64 = buf.Length;
                    ctx.Response.OutputStream.Write(buf, 0, buf.Length);
                    ctx.Response.OutputStream.Close();
                } else if (ctx.Request.IsWebSocketRequest) {
                    var ws = ctx.AcceptWebSocketAsync(null).Result.WebSocket;
                    Task.Run(() => Echo(ws));
                } else {
                    ctx.Response.StatusCode = 404;
                    ctx.Response.OutputStream.Close();
                }
            } catch {}
        }
    }

    static async void Echo(WebSocket ws) {
        try {
            // ttyd 协议：首字节 '0' = 终端输出
            var hello = Encoding.UTF8.GetBytes("0mock-ttyd shell ready\r\n$ ");
            await ws.SendAsync(new ArraySegment<byte>(hello), WebSocketMessageType.Binary, true, CancellationToken.None);
            var buf = new byte[4096];
            while (ws.State == WebSocketState.Open) {
                var r = await ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None);
                if (r.MessageType == WebSocketMessageType.Close) {
                    await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None);
                    return;
                }
                if (r.Count > 1) { // 回显客户端输入（跳过 1 字节操作码）
                    var outBuf = new byte[r.Count];
                    outBuf[0] = (byte)'0';
                    Array.Copy(buf, 1, outBuf, 1, r.Count - 1);
                    await ws.SendAsync(new ArraySegment<byte>(outBuf), WebSocketMessageType.Binary, true, CancellationToken.None);
                }
            }
        } catch {}
    }
}
