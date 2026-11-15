/**
 * ============================================================================
 * S.I.G.M.A. Single Universal App — Dynamic Role Assignment Module
 * ============================================================================
 * Kerangka logika klien universal (Vanilla JS / TypeScript / React) untuk
 * meminta peran otomatis (`REQUEST_ROLE`) ke server WebSocket dan mengeksekusi
 * `initMasterMode()` atau `initClientMode()` berdasarkan balasan `ROLE_ASSIGNED`.
 */

export type AssignedRole = 'MASTER' | 'CLIENT';

export interface RoleAssignedPayload {
  type: 'ROLE_ASSIGNED';
  role: AssignedRole;
  peerId: string;
  masterId: string | null;
}

export interface NewClientJoinedPayload {
  type: 'NEW_CLIENT_JOINED';
  clientId: string;
  senderId: string;
  timestamp: number;
}

export interface UniversalRoleOptions {
  wsUrl?: string;
  peerId?: string;
  initMasterMode: (info: {
    ws: WebSocket;
    peerId: string;
  }) => void;
  initClientMode: (info: {
    ws: WebSocket;
    peerId: string;
    masterId: string | null;
  }) => void;
  onNewClientJoined?: (payload: NewClientJoinedPayload) => void;
}

/**
 * Menghubungkan perangkat ke WebSocket Signaling Server, mengirim `{ type: "REQUEST_ROLE" }`,
 * dan otomatis memanggil `initMasterMode()` jika ditetapkan sebagai `MASTER`
 * atau `initClientMode()` jika ditetapkan sebagai `CLIENT`.
 */
export function initUniversalRoleAssignment(options: UniversalRoleOptions): {
  socket: WebSocket | null;
  requestRoleAgain: () => void;
  disconnect: () => void;
} {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = options.wsUrl || `${protocol}//${window.location.host}/ws`;
  const peerId =
    options.peerId ||
    `client-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  let ws: WebSocket | null = null;
  let isDisposed = false;

  const sendRequestRole = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'REQUEST_ROLE',
          peerId,
        })
      );
    }
  };

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      if (isDisposed) return;
      // 1. Saat aplikasi dimuat & WebSocket terhubung, langsung kirim REQUEST_ROLE
      sendRequestRole();
    };

    ws.onmessage = (event) => {
      if (isDisposed || !ws) return;

      let data: Record<string, unknown> | null = null;
      try {
        data = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!data || typeof data.type !== 'string') return;

      // 2. Listener untuk menerima pesan "ROLE_ASSIGNED"
      if (data.type === 'ROLE_ASSIGNED') {
        const assignedRole = String(data.role).toUpperCase();
        const assignedPeerId = String(data.peerId || peerId);
        const currentMasterId = data.masterId ? String(data.masterId) : null;

        // 3. Struktur IF/ELSE penentuan mode aplikasi
        if (assignedRole === 'MASTER') {
          options.initMasterMode({
            ws,
            peerId: assignedPeerId,
          });
        } else if (assignedRole === 'CLIENT') {
          options.initClientMode({
            ws,
            peerId: assignedPeerId,
            masterId: currentMasterId,
          });
        }
        return;
      }

      // Notifikasi tambahan ke Master saat ada Klien baru yang bergabung di antrean
      if (data.type === 'NEW_CLIENT_JOINED' && options.onNewClientJoined) {
        options.onNewClientJoined(data as unknown as NewClientJoinedPayload);
      }
    };
  } catch {}

  return {
    socket: ws,
    requestRoleAgain: sendRequestRole,
    disconnect: () => {
      isDisposed = true;
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
    },
  };
}
