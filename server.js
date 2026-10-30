// WebSocket -> TCP relay for tg-ws-proxy.
//
// Protocol used by the client (same as Flowseal's Cloudflare Worker):
//   wss://<this-host>/apiws?dst=<telegram-dc-ip>&dc=<dc-number>
// The client tunnels raw MTProto bytes; this relay opens TCP to <dst>:443
// and pipes both directions. No parsing, no logging of payloads.
//
// Works on Render / Railway / Fly / any Node host.

const http = require("http");
const net = require("net");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8080);
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const server = http.createServer((req, res) => {
  res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
  res.end("Expected websocket upgrade");
});

const wss = new WebSocketServer({ server, path: "/apiws", maxPayload: 8 * 1024 * 1024 });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const dst = url.searchParams.get("dst");
  const dc = url.searchParams.get("dc") || "?";

  if (!dst || !/^[a-zA-Z0-9.\-:]+$/.test(dst)) {
    ws.close(1008, "bad dst");
    return;
  }
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(dst)) {
    ws.close(1008, "dst not allowed");
    return;
  }

  const tcp = net.connect({ host: dst, port: 443 });
  tcp.setNoDelay(true);
  tcp.setKeepAlive(true, 30000);

  tcp.on("connect", () => {
    console.log(`[+] DC${dc} -> ${dst}:443 open`);
  });

  tcp.on("data", (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });

  tcp.on("error", (err) => {
    console.log(`[!] DC${dc} -> ${dst}:443 ${err.code || err.message}`);
    try {
      ws.close(1011, "tcp error");
    } catch {}
  });

  tcp.on("close", () => {
    try {
      ws.close();
    } catch {}
  });

  ws.on("message", (data) => {
    if (!tcp.destroyed) tcp.write(data);
  });

  ws.on("close", () => tcp.destroy());
  ws.on("error", () => tcp.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`tgws relay listening on :${PORT}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
