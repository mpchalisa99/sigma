import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface SignalingPayload {
  type: string;
  id?: string;
  senderId?: string;
  targetId?: string;
  target?: string;
  data?: unknown;
  sdp?: unknown;
  candidate?: unknown;
  role?: string;
  peerId?: string;
  nodeId?: string;
  [key: string]: unknown;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const server = http.createServer(app);
  const PORT = Number(process.env.PORT) || 3000;

  // ============================================================================
  // 1. REGISTRASI & ROUTING WEBSOCKET SINKRON (`clients = new Map<string, ws>()`)
  // ============================================================================
  const clients = new Map<string, WebSocket>();
  const masterSockets = new Set<WebSocket>();
  const socketToId = new Map<WebSocket, string>();
  const httpMailboxes = new Map<string, SignalingPayload[]>();

  const enqueueMailbox = (targetId: string, packet: SignalingPayload) => {
    const queue = httpMailboxes.get(targetId) || [];
    queue.push(packet);
    if (queue.length > 50) queue.shift();
    httpMailboxes.set(targetId, queue);
  };

  const wss = new WebSocketServer({ noServer: true });
  const hmrWss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      if (protocols.has('vite-hmr')) return 'vite-hmr';
      if (protocols.has('vite-ping')) return 'vite-ping';
      const first = protocols.values().next().value;
      return first || false;
    },
  });

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    const protocolHeader = String(
      request.headers['sec-websocket-protocol'] || ''
    );
    const reqUrl = request.url || '/';

    if (
      protocolHeader.includes('vite-hmr') ||
      protocolHeader.includes('vite-ping') ||
      reqUrl.includes('token=') ||
      reqUrl.includes('__vite')
    ) {
      hmrWss.handleUpgrade(request, socket, head, (ws) => {
        ws.on('error', () => {});
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'connected' }));
        }
        ws.on('message', (msg) => {
          try {
            const parsed = JSON.parse(msg.toString());
            if (parsed?.type === 'ping' && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
          } catch {}
        });
      });
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    console.log('[SERVER-WS] Koneksi WebSocket baru masuk.');

    ws.on('message', (rawMessage) => {
      let data: SignalingPayload | null = null;
      try {
        data = JSON.parse(rawMessage.toString()) as SignalingPayload;
      } catch (err) {
        console.error('[SERVER-WS] Gagal parse JSON:', err);
        return;
      }

      if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
        return;
      }

      console.log(
        `[SERVER-WS] Incoming Message -> type: "${data.type}", id: "${
          data.id || ''
        }", senderId: "${data.senderId || ''}", targetId: "${
          data.targetId || data.target || ''
        }"`
      );

      // ======================================================================
      // ATURAN 1: REGISTRASI WAJIB (`{ type: "register", id: "MASTER" | myClientId }`)
      // ======================================================================
      if (
        data.type === 'register' ||
        data.type === 'REGISTER' ||
        data.type === 'register_master' ||
        data.type === 'register_client'
      ) {
        const rawId = String(
          data.id ||
            data.senderId ||
            (data.type === 'register_master' ? 'MASTER' : '')
        );
        if (!rawId) {
          console.warn('[SERVER-WS] Pesan register ditolak karena id kosong!');
          return;
        }

        const normalizedId =
          rawId.toUpperCase() === 'MASTER' ? 'MASTER' : rawId;

        clients.set(normalizedId, ws);
        socketToId.set(ws, normalizedId);
        if (normalizedId === 'MASTER') {
          masterSockets.add(ws);
        }

        console.log(
          `[SERVER-WS] REGISTERED: id="${normalizedId}" | Total Peer Aktif: ${
            clients.size
          } -> [${Array.from(clients.keys()).join(', ')}]`
        );

        // Jika MASTER baru saja register, beri tahu semua Client yang sudah menunggu
        // agar langsung mengirim ulang Offer ke MASTER
        if (normalizedId === 'MASTER') {
          clients.forEach((clientWs, clientId) => {
            if (
              clientId !== 'MASTER' &&
              clientWs.readyState === WebSocket.OPEN
            ) {
              console.log(
                `[SERVER-WS] Memberi tahu Client "${clientId}" bahwa MASTER sudah online.`
              );
              clientWs.send(
                JSON.stringify({
                  type: 'master_online',
                  senderId: 'MASTER',
                  targetId: clientId,
                })
              );
            }
          });
        } else {
          // Jika Client baru register dan MASTER sudah online, beri tahu Client bahwa MASTER siap
          const masterWs = clients.get('MASTER');
          if (masterWs && masterWs.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'master_online',
                senderId: 'MASTER',
                targetId: normalizedId,
              })
            );
          }
        }
        return;
      }

      // Dukungan Dynamic Role Assignment (`REQUEST_ROLE`) tanpa menimpa socket MASTER utama
      if (data.type === 'REQUEST_ROLE') {
        const masterWs = clients.get('MASTER');
        const isMasterOnline =
          masterWs !== undefined && masterWs.readyState === WebSocket.OPEN;
        const peerId = String(
          data.peerId ||
            data.id ||
            data.senderId ||
            `client-${Math.floor(1000 + Math.random() * 9000)}`
        );

        if (!isMasterOnline) {
          console.log(
            `[SERVER-WS] REQUEST_ROLE -> Menetapkan "${peerId}" sebagai MASTER`
          );
          ws.send(
            JSON.stringify({
              type: 'ROLE_ASSIGNED',
              role: 'MASTER',
              peerId: 'MASTER',
              masterId: 'MASTER',
            })
          );
        } else {
          console.log(
            `[SERVER-WS] REQUEST_ROLE -> Menetapkan "${peerId}" sebagai CLIENT`
          );
          ws.send(
            JSON.stringify({
              type: 'ROLE_ASSIGNED',
              role: 'CLIENT',
              peerId,
              masterId: 'MASTER',
            })
          );
        }
        return;
      }

      // Pastikan pengirim otomatis terdaftar di Map jika belum sempat mengirim `register`
      if (data.senderId) {
        const senderKey =
          data.senderId.toUpperCase() === 'MASTER' ? 'MASTER' : data.senderId;
        if (!clients.has(senderKey)) {
          clients.set(senderKey, ws);
          socketToId.set(ws, senderKey);
          if (senderKey === 'MASTER') {
            masterSockets.add(ws);
          }
          console.log(
            `[SERVER-WS] Auto-registered senderId="${senderKey}" ke dalam Map.`
          );
        }
      }

      // ======================================================================
      // ATURAN 2: ROUTING YANG SINKRON KE `clients.get(data.targetId)`
      // ======================================================================
      const rawTargetId = String(data.targetId || data.target || '');
      if (!rawTargetId) {
        console.warn(
          `[SERVER-WS] Pesan type="${data.type}" dari "${data.senderId}" diabaikan karena tidak memiliki targetId!`
        );
        return;
      }

      const targetId =
        rawTargetId.toUpperCase() === 'MASTER' ? 'MASTER' : rawTargetId;

      // Normalisasi payload agar `data`, `sdp`, dan `candidate` selalu tersedia di penerima
      const normalizedPacket: SignalingPayload = {
        ...data,
        senderId:
          data.senderId?.toUpperCase() === 'MASTER' ? 'MASTER' : data.senderId,
        targetId,
        data:
          data.data !== undefined
            ? data.data
            : data.sdp !== undefined
            ? data.sdp
            : data.candidate !== undefined
            ? data.candidate
            : undefined,
      };

      const targetWs = clients.get(targetId);
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        console.log(
          `[SERVER-WS] ROUTING OK: "${data.type}" dari "${normalizedPacket.senderId}" -> "${targetId}"`
        );
        targetWs.send(JSON.stringify(normalizedPacket));
      } else {
        console.warn(
          `[SERVER-WS] ROUTING PENDING: targetId="${targetId}" belum aktif di Map! ID yang terdaftar saat ini: [${Array.from(
            clients.keys()
          ).join(', ')}]`
        );
      }

      enqueueMailbox(targetId, normalizedPacket);
    });

    ws.on('close', () => {
      masterSockets.delete(ws);
      const closedId = socketToId.get(ws);
      socketToId.delete(ws);

      if (closedId && clients.get(closedId) === ws) {
        if (closedId === 'MASTER' && masterSockets.size > 0) {
          // Promosikan socket MASTER lain yang masih aktif jika ada
          const nextMasterWs = Array.from(masterSockets).find(
            (s) => s.readyState === WebSocket.OPEN
          );
          if (nextMasterWs) {
            clients.set('MASTER', nextMasterWs);
            console.log(
              '[SERVER-WS] Socket MASTER sekunder ditutup; socket MASTER aktif lainnya tetap dipertahankan.'
            );
            return;
          }
        }

        clients.delete(closedId);
        console.log(
          `[SERVER-WS] DISCONNECTED: id="${closedId}" dihapus dari Map. Sisa peer: [${Array.from(
            clients.keys()
          ).join(', ')}]`
        );

        if (closedId !== 'MASTER') {
          const masterWs = clients.get('MASTER');
          if (masterWs && masterWs.readyState === WebSocket.OPEN) {
            masterWs.send(
              JSON.stringify({
                type: 'client_disconnected',
                senderId: closedId,
                targetId: 'MASTER',
              })
            );
          }
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[SERVER-WS] Socket error:', err);
    });
  });

  // Jalur HTTP Signaling Fallback (/api/signal)
  app.post('/api/signal', (req, res) => {
    const data = req.body as SignalingPayload;
    if (!data || typeof data !== 'object') {
      res.status(400).json({ ok: false });
      return;
    }
    const rawTarget = String(data.targetId || data.target || '');
    const targetId =
      rawTarget.toUpperCase() === 'MASTER' ? 'MASTER' : rawTarget;

    if (targetId) {
      const targetWs = clients.get(targetId);
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(data));
      }
      enqueueMailbox(targetId, data);
    }
    res.json({ ok: true, masterOnline: clients.has('MASTER') });
  });

  app.get('/api/signal/:targetId', (req, res) => {
    const rawTarget = req.params.targetId;
    const targetId =
      rawTarget.toUpperCase() === 'MASTER' ? 'MASTER' : rawTarget;
    const messages = httpMailboxes.get(targetId) || [];
    httpMailboxes.set(targetId, []);
    res.json({
      ok: true,
      messages,
      masterOnline: clients.has('MASTER'),
    });
  });

  app.get('/api/health', (_req, res) => {
    const activeIds = Array.from(clients.keys());
    res.json({
      status: 'ok',
      masterOnline: clients.has('MASTER'),
      connectedIds: activeIds,
      clientsCount: activeIds.filter((id) => id !== 'MASTER').length,
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[SERVER] S.I.G.M.A. Multi-Peer Signaling Server listening on http://0.0.0.0:${PORT}`
    );
  });
}

startServer();
