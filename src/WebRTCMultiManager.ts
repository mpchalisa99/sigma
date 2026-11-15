/**
 * WebRTCMultiManager.ts
 * ============================================================================
 * Arsitektur 1-to-Many (Star Topology) Switchboard untuk WebRTC Master
 * Menangani hingga 5 (atau lebih) Klien secara simultan tanpa saling menimpa:
 *
 * 1. MANAJEMEN MULTI-KONEKSI (SWITCHBOARD):
 *    - `peerConnections[clientId]` menyimpan setiap sesi RTCPeerConnection secara terisolasi.
 * 2. FUNGSI PENANGANAN SIGNALING DINAMIS:
 *    - `handleIncomingOffer(clientId, offer, signalingChannel)`
 *    - `handleIncomingIce(clientId, candidate)`
 * 3. RENDER AUDIO & GPS TERPISAH (ISOLASI TRACK):
 *    - `peerConnection.ontrack` membuat elemen `<audio id="audio-${clientId}" autoplay playsinline>`
 *      unik di dalam `<div id="audio-container">`
 *    - `peerConnection.ondatachannel` mengisolasi kanal telemetri GPS per `clientId`
 * 4. FUNGSI CLEANUP (AUTO-DISCONNECT):
 *    - Saat `iceConnectionState` terputus (`disconnected` / `failed` / `closed`),
 *      otomatis menghapus `<audio id="audio-${clientId}">` dari DOM dan
 *      mengeksekusi `delete peerConnections[clientId]`.
 * ============================================================================
 */

export interface SignalingChannelLike {
  readyState?: number;
  send: (data: string) => void;
}

export interface MultiManagerCallbacks {
  maxClients?: number;
  audioContainerId?: string;
  onTrackAttached?: (
    clientId: string,
    stream: MediaStream,
    audioElement: HTMLAudioElement,
    event: RTCTrackEvent
  ) => void;
  onDataChannelMessage?: (
    clientId: string,
    data: unknown,
    channel: RTCDataChannel
  ) => void;
  onDataChannelOpen?: (clientId: string, channel: RTCDataChannel) => void;
  onClientConnected?: (clientId: string, pc: RTCPeerConnection) => void;
  onClientDisconnected?: (clientId: string, reason: string) => void;
  onAutoplayBlocked?: (clientId: string, audioElement: HTMLAudioElement) => void;
  onAutoplaySuccess?: (clientId: string, audioElement: HTMLAudioElement) => void;
}

export const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// ============================================================================
// 1. MANAJEMEN MULTI-KONEKSI (SWITCHBOARD)
// ============================================================================
/** Dictionary utama untuk menyimpan setiap sesi RTCPeerConnection berdasarkan `clientId` unik */
export const peerConnections: Record<string, RTCPeerConnection> = {};

/** Penyimpanan RTCDataChannel spesifik per `clientId` (untuk GPS & Remote Command) */
export const clientDataChannels: Record<string, RTCDataChannel> = {};

/** Antrean ICE Candidate per `clientId` jika candidate tiba sebelum setRemoteDescription selesai */
const pendingIceCandidates: Record<string, RTCIceCandidateInit[]> = {};

/** Timer grace-period untuk status `disconnected` sementara sebelum benar-benar cleanup */
const disconnectTimers: Record<string, ReturnType<typeof setTimeout>> = {};

/**
 * Memastikan kontainer `<div id="audio-container">` tersedia di dalam DOM.
 */
export function ensureAudioContainer(
  containerId = 'audio-container'
): HTMLElement {
  let container = document.getElementById(containerId);
  if (!container) {
    container = document.createElement('div');
    container.id = containerId;
    // Offscreen stage (bukan display:none agar decoder audio mobile tetap aktif)
    container.style.cssText =
      'position:fixed;bottom:0;left:0;width:1px;height:1px;opacity:0.01;pointer-events:none;overflow:hidden;z-index:-1;';
    document.body.appendChild(container);
  }
  return container;
}

// ============================================================================
// 3. RENDER AUDIO & GPS TERPISAH (ISOLASI TRACK)
// ============================================================================
/**
 * Merender atau memperbarui elemen `<audio id="audio-${clientId}" autoplay playsinline>`
 * secara dinamis di dalam `<div id="audio-container">` untuk masing-masing `clientId`.
 */
export function renderClientAudioElement(
  clientId: string,
  event: RTCTrackEvent,
  callbacks?: MultiManagerCallbacks
): { audioElement: HTMLAudioElement; stream: MediaStream } | null {
  const containerId = callbacks?.audioContainerId || 'audio-container';
  const container = ensureAudioContainer(containerId);

  const elementId = `audio-${clientId}`;
  let audioEl = document.getElementById(elementId) as HTMLAudioElement | null;

  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = elementId;
    audioEl.autoplay = true;
    audioEl.controls = false;
    audioEl.muted = false;
    audioEl.volume = 1.0;

    // Atribut wajib untuk Safari iOS & Chrome/Samsung Android
    audioEl.setAttribute('autoplay', '');
    audioEl.setAttribute('playsinline', '');
    audioEl.setAttribute('webkit-playsinline', '');
    (audioEl as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    audioEl.dataset.clientId = clientId;

    container.appendChild(audioEl);
  }

  // Rakitan MediaStream terisolasi khusus untuk `clientId` ini
  const combinedTracks = new Map<string, MediaStreamTrack>();

  const existingStream =
    audioEl.srcObject instanceof MediaStream ? audioEl.srcObject : null;
  if (existingStream) {
    existingStream.getTracks().forEach((t) => {
      if (t.readyState !== 'ended') {
        combinedTracks.set(t.id, t);
      }
    });
  }

  if (event.streams && event.streams[0]) {
    event.streams[0].getTracks().forEach((t) => {
      t.enabled = true;
      combinedTracks.set(t.id, t);
    });
  }

  if (event.track) {
    event.track.enabled = true;
    combinedTracks.set(event.track.id, event.track);
  }

  const isolatedStream = new MediaStream(Array.from(combinedTracks.values()));
  audioEl.srcObject = isolatedStream;
  audioEl.muted = false;

  const playPromise = audioEl.play();
  if (playPromise !== undefined) {
    playPromise
      .then(() => {
        callbacks?.onAutoplaySuccess?.(clientId, audioEl!);
      })
      .catch((err: unknown) => {
        const errorName = err instanceof Error ? err.name : String(err);
        if (errorName === 'NotAllowedError') {
          callbacks?.onAutoplayBlocked?.(clientId, audioEl!);
        }
      });
  }

  callbacks?.onTrackAttached?.(clientId, isolatedStream, audioEl, event);
  return { audioElement: audioEl, stream: isolatedStream };
}

// ============================================================================
// 4. FUNGSI CLEANUP (AUTO-DISCONNECT)
// ============================================================================
/**
 * Membersihkan sesi WebRTC milik `clientId`:
 * - Menghapus elemen `<audio id="audio-${clientId}">` dari DOM
 * - Menutup DataChannel & RTCPeerConnection
 * - Menghapus `delete peerConnections[clientId]` agar slot bersih untuk koneksi ulang
 */
export function cleanupClientConnection(
  clientId: string,
  reason = 'disconnected',
  callbacks?: MultiManagerCallbacks
): void {
  if (disconnectTimers[clientId]) {
    clearTimeout(disconnectTimers[clientId]);
    delete disconnectTimers[clientId];
  }

  // 1. Hapus elemen <audio id="audio-${clientId}"> dari DOM
  const audioIds = [`audio-${clientId}`, `audio-client-${clientId}`];
  audioIds.forEach((id) => {
    const el = document.getElementById(id) as HTMLAudioElement | null;
    if (el) {
      try {
        el.pause();
        el.srcObject = null;
        el.remove();
      } catch {}
    }
  });

  // 2. Tutup & hapus RTCDataChannel milik clientId
  const dc = clientDataChannels[clientId];
  if (dc) {
    try {
      dc.onmessage = null;
      dc.onopen = null;
      dc.onclose = null;
      dc.close();
    } catch {}
    delete clientDataChannels[clientId];
  }

  // 3. Tutup & hapus RTCPeerConnection milik clientId dari switchboard
  const pc = peerConnections[clientId];
  if (pc) {
    try {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.ondatachannel = null;
      pc.oniceconnectionstatechange = null;
      pc.onconnectionstatechange = null;
      pc.close();
    } catch {}
    delete peerConnections[clientId];
  }

  delete pendingIceCandidates[clientId];

  callbacks?.onClientDisconnected?.(clientId, reason);
}

// ============================================================================
// 2. FUNGSI PENANGANAN SIGNALING DINAMIS
// ============================================================================
/**
 * Menangani `Offer` yang masuk dari `clientId` tertentu secara dinamis (Star Topology 1-to-Many).
 *
 * a. Mengecek apakah `peerConnections[clientId]` sudah ada (jika sesi lama mati/reconnecting,
 *    dibersihkan lalu dibuatkan `new RTCPeerConnection` baru khusus untuk `clientId`).
 * b. Menyimpan koneksi baru ke dalam `peerConnections[clientId]`.
 * c. Melakukan `setRemoteDescription`, `createAnswer`, `setLocalDescription`, dan mengirim
 *    kembali `Answer` spesifik ke `target: clientId`.
 */
export async function handleIncomingOffer(
  clientId: string,
  offer: RTCSessionDescriptionInit,
  signalingChannel: SignalingChannelLike,
  callbacks?: MultiManagerCallbacks,
  rtcConfig: RTCConfiguration = DEFAULT_RTC_CONFIG
): Promise<RTCPeerConnection | null> {
  if (!clientId || !offer) return null;

  const maxClients = callbacks?.maxClients ?? 5;
  const activeClientIds = Object.keys(peerConnections);
  const isExistingClient = Boolean(peerConnections[clientId]);

  // Batasi maksimal 5 klien simultan (kecuali klien yang sama sedang auto-reconnect)
  if (!isExistingClient && activeClientIds.length >= maxClients) {
    return null;
  }

  if (disconnectTimers[clientId]) {
    clearTimeout(disconnectTimers[clientId]);
    delete disconnectTimers[clientId];
  }

  // a. Cek apakah `peerConnections[clientId]` sudah ada.
  // Jika sudah ada namun Klien mengirim Offer baru (misal saat Auto-Reconnect atau Renegotiation):
  let pc = peerConnections[clientId];
  if (
    pc &&
    (pc.signalingState === 'closed' ||
      pc.iceConnectionState === 'failed' ||
      pc.iceConnectionState === 'closed' ||
      pc.connectionState === 'failed' ||
      pc.connectionState === 'closed')
  ) {
    try {
      pc.close();
    } catch {}
    delete peerConnections[clientId];
    pc = undefined as unknown as RTCPeerConnection;
  }

  if (!pc) {
    // Ciptakan `new RTCPeerConnection(...)` baru khusus untuk Klien tersebut
    pc = new RTCPeerConnection(rtcConfig);

    // b. Simpan koneksi baru tersebut ke dalam `peerConnections[clientId]`
    peerConnections[clientId] = pc;
    if (!pendingIceCandidates[clientId]) {
      pendingIceCandidates[clientId] = [];
    }

    // Handler ICE Candidate: kirim kembali spesifik ke `target: clientId`
    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate && signalingChannel) {
        const isOpen =
          typeof signalingChannel.readyState === 'number'
            ? signalingChannel.readyState === 1 // WebSocket.OPEN
            : true;
        if (isOpen) {
          signalingChannel.send(
            JSON.stringify({
              type: 'candidate',
              role: 'master',
              senderId: 'master',
              target: clientId,
              clientId,
              candidate: event.candidate.toJSON
                ? event.candidate.toJSON()
                : event.candidate,
            })
          );
        }
      }
    };

    // 3. ISOLASI TRACK AUDIO: Buat <audio id="audio-${clientId}" autoplay playsinline>
    pc.ontrack = (trackEvent: RTCTrackEvent) => {
      renderClientAudioElement(clientId, trackEvent, callbacks);
    };

    // 3b. ISOLASI DATA CHANNEL (GPS & TELEMETRI): Khusus untuk `clientId` ini
    pc.ondatachannel = (dcEvent: RTCDataChannelEvent) => {
      const channel = dcEvent.channel;
      clientDataChannels[clientId] = channel;

      channel.onopen = () => {
        callbacks?.onDataChannelOpen?.(clientId, channel);
      };

      channel.onmessage = (msgEvent: MessageEvent) => {
        let parsed: unknown = msgEvent.data;
        if (typeof msgEvent.data === 'string') {
          try {
            parsed = JSON.parse(msgEvent.data);
          } catch {
            parsed = msgEvent.data;
          }
        }
        callbacks?.onDataChannelMessage?.(clientId, parsed, channel);
      };

      channel.onclose = () => {
        if (clientDataChannels[clientId] === channel) {
          delete clientDataChannels[clientId];
        }
      };
    };

    // 4. AUTO-DISCONNECT & CLEANUP BERDASARKAN `iceConnectionState`
    pc.oniceconnectionstatechange = () => {
      if (peerConnections[clientId] !== pc) return;
      const iceState = pc.iceConnectionState;

      if (iceState === 'connected' || iceState === 'completed') {
        if (disconnectTimers[clientId]) {
          clearTimeout(disconnectTimers[clientId]);
          delete disconnectTimers[clientId];
        }
        callbacks?.onClientConnected?.(clientId, pc);
      } else if (iceState === 'failed' || iceState === 'closed') {
        cleanupClientConnection(clientId, iceState, callbacks);
      } else if (iceState === 'disconnected') {
        // Beri jeda singkat 4 detik untuk mengantisipasi fluktuasi sinyal seluler sebelum cleanup penuh
        if (disconnectTimers[clientId]) {
          clearTimeout(disconnectTimers[clientId]);
        }
        disconnectTimers[clientId] = setTimeout(() => {
          if (
            peerConnections[clientId] === pc &&
            (pc.iceConnectionState === 'disconnected' ||
              pc.iceConnectionState === 'failed' ||
              pc.iceConnectionState === 'closed')
          ) {
            cleanupClientConnection(clientId, 'disconnected', callbacks);
          }
        }, 4000);
      }
    };

    pc.onconnectionstatechange = () => {
      if (peerConnections[clientId] !== pc) return;
      const connState = pc.connectionState;
      if (connState === 'connected') {
        callbacks?.onClientConnected?.(clientId, pc);
      } else if (connState === 'failed' || connState === 'closed') {
        cleanupClientConnection(clientId, connState, callbacks);
      }
    };
  }

  // c. Lakukan `setRemoteDescription`, lalu `createAnswer`, dan kirim kembali `Answer` spesifik ke `clientId`
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    // Eksekusi semua ICE candidate milik `clientId` yang sempat mengantre sebelum RemoteDescription siap
    const queued = pendingIceCandidates[clientId] || [];
    while (queued.length > 0) {
      const nextCandidate = queued.shift();
      if (nextCandidate) {
        await pc
          .addIceCandidate(new RTCIceCandidate(nextCandidate))
          .catch(() => {});
      }
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    const isOpen =
      typeof signalingChannel.readyState === 'number'
        ? signalingChannel.readyState === 1
        : true;

    if (isOpen && pc.localDescription) {
      signalingChannel.send(
        JSON.stringify({
          type: 'answer',
          role: 'master',
          senderId: 'master',
          target: clientId,
          clientId,
          sdp: {
            type: pc.localDescription.type,
            sdp: pc.localDescription.sdp,
          },
        })
      );
    }

    return pc;
  } catch {
    return null;
  }
}

/**
 * Menambahkan ICE Candidate HANYA ke `peerConnections[clientId]` yang cocok,
 * bukan ke koneksi Klien lain.
 */
export async function handleIncomingIce(
  clientId: string,
  candidate: RTCIceCandidateInit
): Promise<boolean> {
  if (!clientId || !candidate) return false;

  const pc = peerConnections[clientId];

  // Jika peerConnections[clientId] belum selesai diinisialisasi atau remoteDescription belum terpasang,
  // simpan di antrean khusus `clientId` tersebut.
  if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
    if (!pendingIceCandidates[clientId]) {
      pendingIceCandidates[clientId] = [];
    }
    pendingIceCandidates[clientId].push(candidate);
    return false;
  }

  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
    return true;
  } catch {
    return false;
  }
}

/**
 * Membersihkan seluruh sesi Klien sekaligus (misal saat Master keluar / unmount).
 */
export function cleanupAllClientConnections(
  callbacks?: MultiManagerCallbacks
): void {
  Object.keys(peerConnections).forEach((clientId) => {
    cleanupClientConnection(clientId, 'master_shutdown', callbacks);
  });
}
