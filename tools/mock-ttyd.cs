using System;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// Mock ttyd（本地开发/联调用）：
//  - 解析 server/index.js 传入的 -i <addr> -p <port> <shell...> 参数（缺省 127.0.0.1:7681）
//    ⚠️ 早期版本硬编码 127.0.0.1:7681 并忽略 -p，导致它抢占别的实例的端口、
//       本实例却因端口冲突静默退出，表现为「终端不可用」且无任何诊断信息。
//  - GET /token          返回 {"token":"mock-token"}
//  - WS   /ws            按 ttyd 帧协议工作：输出帧首字节 '0'，回显客户端输入
// 由 server/index.js 通过 TTYD_PATH 指向本 exe 自动拉起，无需手动运行。
// ⚠️ 启动失败必须写 stderr 并以非 0 退出码结束：server 会把 stderr 以 [ttyd] 前缀透传到日志，
//    是端口冲突 / 权限不足的唯一诊断来源（运行期异常仍吞掉，避免把无关噪音打进日志）。
//    诊断文案一律用 ASCII：Console.Error 走系统 ANSI 代码页（中文环境下为 GBK），
//    而 Node 侧按 UTF-8 渲染，写中文会变成乱码，诊断等于失效。
class MockTtyd {
    static int Main(string[] args) {
        string host = "127.0.0.1";
        int port = 7681;
        for (int i = 0; i < args.Length; i++) {
            if ((args[i] == "-i" || args[i] == "--interface") && i + 1 < args.Length) {
                host = args[++i];
            } else if ((args[i] == "-p" || args[i] == "--port") && i + 1 < args.Length) {
                int parsed;
                if (int.TryParse(args[++i], out parsed)) port = parsed;
            }
        }
        // HttpListener 不接受通配地址，0.0.0.0 需写成 "+"
        if (host == "0.0.0.0" || host == "*") host = "+";

        var listener = new HttpListener();
        string prefix = "http://" + host + ":" + port + "/";
        try {
            listener.Prefixes.Add(prefix);
            listener.Start();
        } catch (Exception e) {
            Console.Error.WriteLine("[mock-ttyd] failed to listen on " + prefix + ": " + e.Message);
            return 1;
        }
        Console.Error.WriteLine("[mock-ttyd] listening on " + prefix);

        Serve(listener);
        return 0;
    }

    static void Serve(HttpListener listener) {
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