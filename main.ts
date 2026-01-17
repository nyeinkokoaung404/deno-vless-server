// main.ts - VLESS WebSocket Proxy Server

const userID = Deno.env.get('UUID') || '9afd1229-b893-40c1-84dd-51e7ce204913'
const proxyIP = Deno.env.get('PROXYIP') || ''

// UUID validation function
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  return uuidRegex.test(uuid)
}

// Validate UUID on startup
if (!isValidUUID(userID)) {
  throw new Error('UUID is not valid')
}

console.log('Server starting with UUID:', userID)
console.log('Deno version:', Deno.version)

// WebSocket ready states
const WS_READY_STATE_OPEN = 1
const WS_READY_STATE_CLOSING = 2

// Main server handler
Deno.serve(async (request: Request) => {
  const upgrade = request.headers.get('upgrade') || ''
  
  if (upgrade.toLowerCase() !== 'websocket') {
    const url = new URL(request.url)
    
    switch (url.pathname) {
      case '/':
        return new Response('VLESS WebSocket Proxy Server', {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
          },
        })
        
      case `/${userID}`: {
        const host = url.hostname
        const port = url.port || (url.protocol === 'https:' ? '443' : '80')
        const vlessConfig = getVLESSConfig(userID, host, port)
        return new Response(vlessConfig, {
          status: 200,
          headers: {
            'Content-Type': 'text/plain;charset=utf-8',
          },
        })
      }
      
      case '/config': {
        const url = new URL(request.url)
        const host = url.hostname
        const port = url.port || (url.protocol === 'https:' ? '443' : '80')
        const config = generateHTMLConfigPage(userID, host, port)
        return new Response(config, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
          },
        })
      }
      
      case '/health':
        return new Response('OK', { status: 200 })
        
      default:
        return new Response('Not Found', { status: 404 })
    }
  } else {
    // Handle WebSocket connection for VLESS proxy
    return await vlessOverWSHandler(request)
  }
})

// VLESS over WebSocket handler
async function vlessOverWSHandler(request: Request): Promise<Response> {
  const { socket, response } = Deno.upgradeWebSocket(request)
  
  let address = ''
  let portWithRandomLog = ''
  
  const log = (info: string, event: any = '') => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event)
  }
  
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || ''
  const readableWebSocketStream = makeReadableWebSocketStream(socket, earlyDataHeader, log)
  
  let remoteSocketWrapper: { value: Deno.TcpConn | null } = {
    value: null,
  }
  
  let udpStreamWrite: ((chunk: Uint8Array) => void) | null = null
  let isDns = false

  // Pipe WebSocket stream to remote connection
  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk: any, controller) {
          if (isDns && udpStreamWrite) {
            return udpStreamWrite(chunk)
          }
          
          if (remoteSocketWrapper.value) {
            const writer = remoteSocketWrapper.value.writable.getWriter()
            await writer.write(new Uint8Array(chunk))
            writer.releaseLock()
            return
          }

          const {
            hasError,
            message,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            vlessVersion = new Uint8Array([0, 0]),
            isUDP,
          } = processVlessHeader(chunk, userID)
          
          address = addressRemote
          portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '}`
          
          if (hasError) {
            throw new Error(message)
          }
          
          // UDP only for DNS (port 53)
          if (isUDP) {
            if (portRemote === 53) {
              isDns = true
            } else {
              throw new Error('UDP proxy only enabled for DNS (port 53)')
            }
          }
          
          const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0])
          const rawClientData = chunk.slice(rawDataIndex)

          if (isDns) {
            const { write } = await handleUDPOutBound(socket, vlessResponseHeader, log)
            udpStreamWrite = write
            udpStreamWrite(rawClientData)
            return
          }
          
          handleTCPOutBound(
            remoteSocketWrapper,
            addressRemote,
            portRemote,
            rawClientData,
            socket,
            vlessResponseHeader,
            log
          )
        },
        close() {
          log(`readableWebSocketStream is closed`)
        },
        abort(reason) {
          log(`readableWebSocketStream is aborted`, JSON.stringify(reason))
        },
      })
    )
    .catch((err) => {
      log('readableWebSocketStream pipeTo error', err)
    })

  return response
}

// Create readable stream from WebSocket
function makeReadableWebSocketStream(
  webSocketServer: WebSocket,
  earlyDataHeader: string,
  log: (info: string, event?: any) => void
): ReadableStream {
  let readableStreamCancel = false
  
  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) {
          return
        }
        const message = event.data
        controller.enqueue(message)
      })

      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer)
        if (readableStreamCancel) {
          return
        }
        controller.close()
      })
      
      webSocketServer.addEventListener('error', (err) => {
        log('webSocketServer has error')
        controller.error(err)
      })
      
      // Handle early data (0-RTT)
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader)
      if (error) {
        controller.error(error)
      } else if (earlyData) {
        controller.enqueue(earlyData)
      }
    },

    cancel(reason) {
      if (readableStreamCancel) {
        return
      }
      log(`ReadableStream was canceled, due to ${reason}`)
      readableStreamCancel = true
      safeCloseWebSocket(webSocketServer)
    },
  })
}

// Process VLESS protocol header
function processVlessHeader(
  vlessBuffer: ArrayBuffer,
  userID: string
): {
  hasError: boolean
  message?: string
  addressRemote?: string
  addressType?: number
  portRemote?: number
  rawDataIndex?: number
  vlessVersion?: Uint8Array
  isUDP?: boolean
} {
  if (vlessBuffer.byteLength < 24) {
    return {
      hasError: true,
      message: 'Invalid data',
    }
  }
  
  const version = new Uint8Array(vlessBuffer.slice(0, 1))
  let isValidUser = false
  let isUDP = false
  
  // Check UUID
  if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
    isValidUser = true
  }
  
  if (!isValidUser) {
    return {
      hasError: true,
      message: 'Invalid user',
    }
  }

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0]
  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0]

  // Command: 0x01 TCP, 0x02 UDP, 0x03 MUX
  if (command === 1) {
    // TCP
  } else if (command === 2) {
    isUDP = true
  } else {
    return {
      hasError: true,
      message: `Command ${command} is not supported (01=tcp, 02=udp, 03=mux)`,
    }
  }
  
  const portIndex = 18 + optLength + 1
  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2)
  const portRemote = new DataView(portBuffer).getUint16(0)

  let addressIndex = portIndex + 2
  const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))
  const addressType = addressBuffer[0]
  
  let addressLength = 0
  let addressValueIndex = addressIndex + 1
  let addressValue = ''
  
  switch (addressType) {
    case 1: // IPv4
      addressLength = 4
      addressValue = new Uint8Array(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join('.')
      break
      
    case 2: // Domain
      addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0]
      addressValueIndex += 1
      addressValue = new TextDecoder().decode(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      )
      break
      
    case 3: // IPv6
      addressLength = 16
      const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength))
      const ipv6: string[] = []
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16))
      }
      addressValue = ipv6.join(':')
      break
      
    default:
      return {
        hasError: true,
        message: `Invalid address type: ${addressType}`,
      }
  }
  
  if (!addressValue) {
    return {
      hasError: true,
      message: `Address value is empty, address type is ${addressType}`,
    }
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP,
  }
}

// Handle TCP outbound connection
async function handleTCPOutBound(
  remoteSocket: { value: Deno.TcpConn | null },
  addressRemote: string,
  portRemote: number,
  rawClientData: Uint8Array,
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  log: (info: string, event?: any) => void
): Promise<void> {
  
  async function connectAndWrite(address: string, port: number): Promise<Deno.TcpConn> {
    const tcpSocket = await Deno.connect({
      port: port,
      hostname: address,
    })
    
    remoteSocket.value = tcpSocket
    log(`Connected to ${address}:${port}`)
    
    const writer = tcpSocket.writable.getWriter()
    await writer.write(rawClientData)
    writer.releaseLock()
    
    return tcpSocket
  }

  async function retry() {
    const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote)
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log)
  }

  const tcpSocket = await connectAndWrite(addressRemote, portRemote)
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log)
}

// Pipe remote socket to WebSocket
async function remoteSocketToWS(
  remoteSocket: Deno.TcpConn,
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  retry: (() => Promise<void>) | null,
  log: (info: string, event?: any) => void
): Promise<void> {
  
  let hasIncomingData = false
  let vlessHeader: Uint8Array | null = vlessResponseHeader
  
  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        async write(chunk: Uint8Array) {
          hasIncomingData = true
          
          if (webSocket.readyState !== WS_READY_STATE_OPEN) {
            throw new Error('WebSocket not open')
          }
          
          if (vlessHeader) {
            const combined = new Uint8Array(vlessHeader.length + chunk.length)
            combined.set(vlessHeader)
            combined.set(chunk, vlessHeader.length)
            webSocket.send(combined)
            vlessHeader = null
          } else {
            webSocket.send(chunk)
          }
        },
        close() {
          log(`Remote socket closed, had incoming data: ${hasIncomingData}`)
        },
        abort(reason) {
          console.error('Remote socket aborted', reason)
        },
      })
    )
    .catch((error) => {
      console.error('remoteSocketToWS error', error)
      safeCloseWebSocket(webSocket)
    })

  // Retry if no data was received
  if (!hasIncomingData && retry) {
    log('Retrying connection...')
    retry()
  }
}

// Handle UDP outbound (for DNS)
async function handleUDPOutBound(
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  log: (info: string, event?: any) => void
): Promise<{ write: (chunk: Uint8Array) => void }> {
  
  let isVlessHeaderSent = false
  
  const transformStream = new TransformStream({
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2)
        const udpPacketLength = new DataView(lengthBuffer.buffer).getUint16(0)
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength))
        index = index + 2 + udpPacketLength
        controller.enqueue(udpData)
      }
    },
  })

  // Handle DNS queries via DoH
  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk: Uint8Array) {
          try {
            const resp = await fetch('https://1.1.1.1/dns-query', {
              method: 'POST',
              headers: {
                'content-type': 'application/dns-message',
              },
              body: chunk,
            })
            
            const dnsQueryResult = await resp.arrayBuffer()
            const udpSize = dnsQueryResult.byteLength
            const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff])
            
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
              log(`DNS query successful, message length: ${udpSize}`)
              
              if (isVlessHeaderSent) {
                webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer())
              } else {
                const combined = new Uint8Array(vlessResponseHeader.length + udpSizeBuffer.length + dnsQueryResult.byteLength)
                combined.set(vlessResponseHeader)
                combined.set(udpSizeBuffer, vlessResponseHeader.length)
                combined.set(new Uint8Array(dnsQueryResult), vlessResponseHeader.length + udpSizeBuffer.length)
                webSocket.send(combined)
                isVlessHeaderSent = true
              }
            }
          } catch (error) {
            log('DNS query failed: ' + error)
          }
        },
      })
    )
    .catch((error) => {
      log('DNS UDP error: ' + error)
    })

  const writer = transformStream.writable.getWriter()

  return {
    write(chunk: Uint8Array) {
      writer.write(chunk)
    },
  }
}

// Base64 to ArrayBuffer converter
function base64ToArrayBuffer(base64Str: string): { earlyData?: ArrayBuffer; error?: any } {
  if (!base64Str) {
    return { error: null }
  }
  
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/')
    const decode = atob(base64Str)
    const arrayBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0))
    return { earlyData: arrayBuffer.buffer }
  } catch (error) {
    return { error }
  }
}

// Safely close WebSocket
function safeCloseWebSocket(socket: WebSocket): void {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close()
    }
  } catch (error) {
    console.error('safeCloseWebSocket error', error)
  }
}

// UUID stringify helper
const byteToHex: string[] = []
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1))
}

function unsafeStringify(arr: Uint8Array, offset = 0): string {
  return (
    byteToHex[arr[offset + 0]] +
    byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] +
    byteToHex[arr[offset + 3]] +
    '-' +
    byteToHex[arr[offset + 4]] +
    byteToHex[arr[offset + 5]] +
    '-' +
    byteToHex[arr[offset + 6]] +
    byteToHex[arr[offset + 7]] +
    '-' +
    byteToHex[arr[offset + 8]] +
    byteToHex[arr[offset + 9]] +
    '-' +
    byteToHex[arr[offset + 10]] +
    byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] +
    byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] +
    byteToHex[arr[offset + 15]]
  ).toLowerCase()
}

function stringify(arr: Uint8Array, offset = 0): string {
  const uuid = unsafeStringify(arr, offset)
  if (!isValidUUID(uuid)) {
    throw new TypeError('Stringified UUID is invalid')
  }
  return uuid
}

// Generate VLESS configuration
function getVLESSConfig(userID: string, hostName: string, port: string | number): string {
  const vlessMain = `vless://${userID}@${hostName}:${port}?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`
  
  return `
################################################################
v2ray
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
clash-meta
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
################################################################
`
}

// Generate HTML configuration page
function generateHTMLConfigPage(userID: string, host: string, port: string): string {
  const config = getVLESSConfig(userID, host, port)
  const configLines = config.split('\n')
  let vlessLink = ''
  let clashConfig = ''
  let capturingClash = false
  
  for (const line of configLines) {
    if (line.includes('vless://')) {
      vlessLink = line.trim()
    }
    
    if (line.includes('clash-meta')) {
      capturingClash = true
      continue
    }
    
    if (capturingClash && line.includes('######')) {
      capturingClash = false
    }
    
    if (capturingClash && !line.includes('clash-meta')) {
      clashConfig += line + '\n'
    }
  }
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VLESS Configuration</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        
        .container {
            background: white;
            border-radius: 12px;
            padding: 30px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        
        h1 {
            color: #333;
            text-align: center;
            margin-bottom: 30px;
        }
        
        .config-section {
            margin-bottom: 25px;
        }
        
        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        
        .section-header h3 {
            color: #555;
            margin: 0;
        }
        
        .copy-btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.3s;
        }
        
        .copy-btn:hover {
            background: #5a6fd8;
        }
        
        .config-box {
            background: #f8f9fa;
            border-radius: 8px;
            padding: 15px;
            font-family: 'Courier New', monospace;
            font-size: 14px;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-x: auto;
        }
        
        .info-box {
            background: #e8f4fd;
            border-left: 4px solid #2196F3;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
        }
        
        .success-message {
            position: fixed;
            top: 20px;
            right: 20px;
            background: #4CAF50;
            color: white;
            padding: 15px 25px;
            border-radius: 8px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
            animation: slideIn 0.3s ease, fadeOut 0.3s ease 2s forwards;
            z-index: 1000;
        }
        
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        
        @keyframes fadeOut {
            from { opacity: 1; }
            to { opacity: 0; }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>VLESS Configuration</h1>
        
        <div class="info-box">
            <strong>Server Information:</strong><br>
            Host: ${host}<br>
            Port: ${port}<br>
            UUID: ${userID}<br>
            Protocol: WebSocket over TLS
        </div>
        
        <div class="config-section">
            <div class="section-header">
                <h3>VLESS Link (v2ray format)</h3>
                <button class="copy-btn" onclick="copyToClipboard('vlessLink')">Copy</button>
            </div>
            <div class="config-box" id="vlessLink">${vlessLink}</div>
        </div>
        
        <div class="config-section">
            <div class="section-header">
                <h3>Clash Meta Configuration</h3>
                <button class="copy-btn" onclick="copyToClipboard('clashConfig')">Copy</button>
            </div>
            <div class="config-box" id="clashConfig">${clashConfig.trim()}</div>
        </div>
        
        <div class="config-section">
            <div class="section-header">
                <h3>Full Configuration</h3>
                <button class="copy-btn" onclick="copyToClipboard('fullConfig')">Copy</button>
            </div>
            <div class="config-box" id="fullConfig">${config}</div>
        </div>
    </div>

    <script>
        function copyToClipboard(elementId) {
            const element = document.getElementById(elementId);
            const text = element.textContent;
            
            navigator.clipboard.writeText(text).then(() => {
                showMessage('Copied to clipboard!');
            }).catch(err => {
                console.error('Failed to copy:', err);
                showMessage('Failed to copy', 'error');
            });
        }
        
        function showMessage(message, type = 'success') {
            const messageDiv = document.createElement('div');
            messageDiv.className = 'success-message';
            messageDiv.textContent = message;
            messageDiv.style.background = type === 'error' ? '#f44336' : '#4CAF50';
            
            document.body.appendChild(messageDiv);
            
            setTimeout(() => {
                if (messageDiv.parentNode) {
                    messageDiv.parentNode.removeChild(messageDiv);
                }
            }, 2500);
        }
    </script>
</body>
</html>
`
}
