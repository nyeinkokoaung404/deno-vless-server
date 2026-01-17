// @ts-ignore
import { serve } from "https://deno.land/std/http/server.ts";

const userID = Deno.env.get('UUID') || '9afd1229-b893-40c1-84dd-51e7ce204913';
const proxyIP = Deno.env.get('PROXYIP') || '';

if (!isValidUUID(userID)) {
  throw new Error('uuid is not valid');
}

console.log("Deno Version:", Deno.version.deno);

// --- Main Server ---

Deno.serve(async (request: Request) => {
  const upgrade = request.headers.get('upgrade') || '';
  const url = new URL(request.url);

  if (upgrade.toLowerCase() !== 'websocket') {
    switch (url.pathname) {
      case '/':
        return new Response(generateHomePageHTML(), {
          status: 200,
          headers: { 'Content-Type': 'text/html;charset=utf-8' },
        });
      case `/config`: {
        const vlessConfig = getVLESSConfig(userID, url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80));
        return new Response(generateConfigHTML(vlessConfig, userID), {
          status: 200,
          headers: { 'Content-Type': 'text/html;charset=utf-8' },
        });
      }
      default:
        return new Response('Not found', { status: 404 });
    }
  } else {
    return await vlessOverWSHandler(request);
  }
});

// --- UI Templates ---

function generateHomePageHTML() {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Channel 404 🇲🇲</title>
    <style>
      body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f0f0f; color: #ffffff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .container { text-align: center; padding: 40px; border-radius: 20px; background: #1a1a1a; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid #333; max-width: 400px; width: 90%; }
      h1 { color: #0088cc; font-size: 2.5rem; margin-bottom: 10px; }
      p { color: #aaa; margin-bottom: 30px; }
      .btn { display: inline-block; background: #0088cc; color: white; padding: 12px 25px; border-radius: 50px; text-decoration: none; font-weight: bold; transition: 0.3s; }
      .btn:hover { background: #00aaff; transform: translateY(-3px); }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Channel 404 🇲🇲</h1>
      <p>Premium Proxy Service</p>
      <a href="https://t.me/premium_channel_404" class="btn" target="_blank">Join Telegram Channel</a>
    </div>
  </body>
  </html>`;
}

function generateConfigHTML(configText, uuid) {
  const vlessLink = configText.match(/vless:\/\/[^\s]+/g)?.[0] || "";
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Config - Channel 404</title>
    <style>
      body { font-family: sans-serif; background: #121212; color: #e0e0e0; padding: 20px; display: flex; justify-content: center; }
      .card { background: #1e1e1e; padding: 25px; border-radius: 15px; max-width: 650px; width: 100%; box-shadow: 0 8px 24px rgba(0,0,0,0.6); }
      h2 { color: #0088cc; border-bottom: 1px solid #333; padding-bottom: 10px; }
      pre { background: #000; padding: 15px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; font-size: 0.85rem; border: 1px solid #444; color: #00ff00; }
      .btn-group { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 20px; }
      button { border: none; padding: 12px; border-radius: 8px; cursor: pointer; font-weight: bold; transition: 0.2s; }
      .btn-primary { background: #0088cc; color: white; }
      .btn-secondary { background: #333; color: white; }
      button:active { transform: scale(0.98); }
      #status { text-align: center; color: #00ff00; font-size: 0.9rem; margin-top: 10px; height: 20px; visibility: hidden; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>VLESS Configuration</h2>
      <p style="font-size: 0.8rem; color: #888;">UUID: ${uuid}</p>
      <pre id="configText">${configText}</pre>
      <div id="status">Copied to clipboard!</div>
      <div class="btn-group">
        <button class="btn-primary" onclick="copyText('all')">Copy All Config</button>
        <button class="btn-secondary" onclick="copyText('link')">Copy VLESS Link Only</button>
      </div>
    </div>
    <script>
      function copyText(type) {
        let text = "";
        if (type === 'all') {
          text = document.getElementById('configText').innerText;
        } else {
          text = \`${vlessLink}\`;
        }
        navigator.clipboard.writeText(text).then(() => {
          const status = document.getElementById('status');
          status.style.visibility = 'visible';
          setTimeout(() => { status.style.visibility = 'hidden'; }, 2000);
        });
      }
    </script>
  </body>
  </html>`;
}

// --- VLESS Logic ---

async function vlessOverWSHandler(request) {
  const { socket, response } = Deno.upgradeWebSocket(request);
  let address = '';
  let portWithRandomLog = '';
  const log = (info, event = '') => { console.log(`[${address}:${portWithRandomLog}] \${info}`, event); };
  
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(socket, earlyDataHeader, log);
  
  let remoteSocketWapper: any = { value: null };
  let udpStreamWrite: any = null;
  let isDns = false;

  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk, controller) {
      if (isDns && udpStreamWrite) return udpStreamWrite(chunk);
      if (remoteSocketWapper.value) {
        const writer = remoteSocketWapper.value.writable.getWriter();
        await writer.write(new Uint8Array(chunk));
        writer.releaseLock();
        return;
      }

      const { hasError, message, portRemote = 443, addressRemote = '', rawDataIndex, vlessVersion = new Uint8Array([0, 0]), isUDP } = processVlessHeader(chunk, userID);
      address = addressRemote;
      portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '} `;
      
      if (hasError) throw new Error(message);
      if (isUDP && portRemote !== 53) throw new Error('UDP only for port 53');
      
      const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);

      if (isUDP && portRemote === 53) {
        isDns = true;
        const { write } = await handleUDPOutBound(socket, vlessResponseHeader, log);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      }
      handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, socket, vlessResponseHeader, log);
    },
    close() { log(`WS Closed`); },
    abort(reason) { log(`WS Abort`, reason); },
  })).catch((err) => log('Pipe error', err));

  return response;
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log) {
  async function connectAndWrite(address, port) {
    const tcpSocket = await Deno.connect({ port, hostname: address });
    remoteSocket.value = tcpSocket;
    const writer = tcpSocket.writable.getWriter();
    await writer.write(new Uint8Array(rawClientData));
    writer.releaseLock();
    return tcpSocket;
  }

  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, async () => {
    const retrySocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
    remoteSocketToWS(retrySocket, webSocket, vlessResponseHeader, null, log);
  }, log);
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  let readableStreamCancel = false;
  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (!readableStreamCancel) controller.enqueue(event.data);
      });
      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        if (!readableStreamCancel) controller.close();
      });
      webSocketServer.addEventListener('error', (err) => controller.error(err));
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) controller.error(error); else if (earlyData) controller.enqueue(earlyData);
    },
    cancel(reason) {
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    },
  });
}

function processVlessHeader(vlessBuffer, userID) {
  if (vlessBuffer.byteLength < 24) return { hasError: true, message: 'invalid data' };
  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) !== userID) return { hasError: true, message: 'invalid user' };

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
  const isUDP = command === 2;
  
  const portIndex = 18 + optLength + 1;
  const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
  
  let addressIndex = portIndex + 2;
  const addressType = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))[0];
  let addressValue = '';
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;

  if (addressType === 1) {
    addressLength = 4;
    addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
  } else if (addressType === 2) {
    addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
    addressValueIndex++;
    addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
  } else if (addressType === 3) {
    addressLength = 16;
    const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
    const ipv6 = [];
    for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
    addressValue = ipv6.join(':');
  }

  return { hasError: false, addressRemote: addressValue, portRemote, rawDataIndex: addressValueIndex + addressLength, vlessVersion: version, isUDP };
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
  let vlessHeader = vlessResponseHeader;
  let hasIncomingData = false;
  await remoteSocket.readable.pipeTo(new WritableStream({
    async write(chunk, controller) {
      hasIncomingData = true;
      if (webSocket.readyState !== 1) controller.error('WS Closed');
      if (vlessHeader) {
        webSocket.send(new Uint8Array([...vlessHeader, ...chunk]));
        vlessHeader = null;
      } else {
        webSocket.send(chunk);
      }
    },
  })).catch((err) => { safeCloseWebSocket(webSocket); });

  if (!hasIncomingData && retry) await retry();
}

async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {
  let isVlessHeaderSent = false;
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength; ) {
        const length = new DataView(chunk.slice(index, index + 2)).getUint16(0);
        controller.enqueue(new Uint8Array(chunk.slice(index + 2, index + 2 + length)));
        index += 2 + length;
      }
    }
  });

  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const resp = await fetch('https://1.1.1.1/dns-query', { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: chunk });
      const dnsQueryResult = await resp.arrayBuffer();
      const udpSize = dnsQueryResult.byteLength;
      const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
      if (webSocket.readyState === 1) {
        if (isVlessHeaderSent) {
          webSocket.send(new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]));
        } else {
          webSocket.send(new Uint8Array([...vlessResponseHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]));
          isVlessHeaderSent = true;
        }
      }
    }
  }));

  const writer = transformStream.writable.getWriter();
  return { write(chunk) { writer.write(chunk); } };
}

function getVLESSConfig(userID, hostName, port) {
  const vlessMain = `vless://${userID}@${hostName}:${port}?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`;
  return `################################################################
v2ray Link:
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
clash-meta Config:
---------------------------------------------------------------
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: ${port}
  uuid: ${userID}
  network: ws
  tls: true
  udp: false
  sni: ${hostName}
  client-fingerprint: chrome
  ws-opts:
    path: "/?ed=2048"
    headers:
      host: ${hostName}
---------------------------------------------------------------
################################################################`;
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { error: null };
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) { return { error }; }
}

function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

function safeCloseWebSocket(socket) {
  try { if (socket.readyState === 1 || socket.readyState === 2) socket.close(); } catch (e) {}
}

function stringify(arr, offset = 0) {
  const byteToHex = [];
  for (let i = 0; i < 256; ++i) byteToHex.push((i + 256).toString(16).slice(1));
  return (
    byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" +
    byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" +
    byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" +
    byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" +
    byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]
  ).toLowerCase();
}
