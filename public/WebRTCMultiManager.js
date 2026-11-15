/**
 * WebRTCMultiManager.js (Vanilla JS ES Module & Global UMD)
 * ============================================================================
 * Modul Switchboard WebRTC 1-to-Many (Star Topology) untuk Master.
 * Mengatasi bottleneck koneksi tunggal dengan menyimpan setiap sesi Klien
 * di dalam `peerConnections[clientId]`, merender elemen `<audio id="audio-${clientId}">`
 * secara terpisah, serta membersihkan sesi secara otomatis saat Klien terputus.
 * ============================================================================
 */

export const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// ============================================================================
// 1. MANAJEMEN MULTI-KONEKSI (SWITCHBOARD)
// ============================================================================
export const peerConnections = {};
export const clientDataChannels = {};
const pendingIceCandidates = {};

/**
 * Memastikan elemen `<div id="audio-container">` tersedia di dalam DOM.
 */
export function ensureAudioContainer(containerId = 'audio-container') {
  let container = document.getElementById(containerId);
  if (!container) {
    container = document.createElement('div');
    container.id = containerId;
    container.style.cssText =
      'position:fixed;bottom:0;left:0;width:1px;height:1px;opacity:0.01;pointer-events:none;overflow:hidden;z-index:-1;';
    document.body.appendChild(container);
  }
  return container;
}

// ============================================================================
// 4. FUNGSI CLEANUP (AUTO-DISCONNECT)
// ============================================================================
export function cleanupClientConnection(clientId, callbacks = {}) {
  // Hapus elemen <audio id="audio-${clientId}"> milik Klien dari DOM
  const audioEl = document.getElementById(`audio-${clientId}`);
  if (audioEl) {
    try {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl.remove();
    } catch (_) {}
  }

  // Tutup DataChannel milik clientId jika ada
  if (clientDataChannels[clientId]) {
    try {
      clientDataChannels[clientId].close();
    } catch (_) {}
    delete clientDataChannels[clientId];
  }

  // Tutup RTCPeerConnection dan hapus dari kamus switchboard
  if (peerConnections[clientId]) {
    try {
      peerConnections[clientId].ontrack = null;
      peerConnections[clientId].onicecandidate = null;
      peerConnections[clientId].ondatachannel = null;
      peerConnections[clientId].oniceconnectionstatechange = null;
      peerConnections[clientId].close();
    } catch (_) {}
    delete peerConnections[clientId];
  }

  delete pendingIceCandidates[clientId];

  if (typeof callbacks.onClientDisconnected === 'function') {
    callbacks.onClientDisconnected(clientId);
  }
}

// ============================================================================
// 2. FUNGSI PENANGANAN SIGNALING DINAMIS (OFFER -> ANSWER)
// ============================================================================
export async function handleIncomingOffer(
  clientId,
  offer,
  signalingChannel,
  callbacks = {}
) {
  if (!clientId || !offer) return null;

  // a. Cek apakah `peerConnections[clientId]` sudah ada.
  // Jika sudah ada tapi kondisinya gagal/tertutup, bersihkan lebih dulu.
  let pc = peerConnections[clientId];
  if (
    pc &&
    (pc.signalingState === 'closed' ||
      pc.iceConnectionState === 'failed' ||
      pc.iceConnectionState === 'closed')
  ) {
    cleanupClientConnection(clientId, callbacks);
    pc = null;
  }

  // Jika belum ada, ciptakan `new RTCPeerConnection(...)` baru khusus untuk Klien tersebut
  if (!pc) {
    pc = new RTCPeerConnection(RTC_CONFIG);

    // b. Simpan koneksi baru tersebut ke dalam `peerConnections[clientId]`
    peerConnections[clientId] = pc;
    pendingIceCandidates[clientId] = [];

    // Kirim ICE Candidate dari Master spesifik ke `clientId`
    pc.onicecandidate = (event) => {
      if (event.candidate && signalingChannel) {
        signalingChannel.send(
          JSON.stringify({
            type: 'candidate',
            senderId: 'master',
            target: clientId,
            clientId: clientId,
            candidate: event.candidate,
          })
        );
      }
    };

    // 3. RENDER AUDIO & GPS TERPISAH (ISOLASI TRACK)
    pc.ontrack = (event) => {
      const container = ensureAudioContainer(
        callbacks.audioContainerId || 'audio-container'
      );

      let audioEl = document.getElementById(`audio-${clientId}`);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = `audio-${clientId}`;
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.setAttribute('autoplay', '');
        audioEl.setAttribute('playsinline', '');
        container.appendChild(audioEl);
      }

      const inboundStream =
        event.streams && event.streams[0]
          ? event.streams[0]
          : new MediaStream([event.track]);

      audioEl.srcObject = inboundStream;
      audioEl.play().catch((err) => {
        if (typeof callbacks.onAutoplayBlocked === 'function') {
          callbacks.onAutoplayBlocked(clientId, audioEl, err);
        }
      });

      if (typeof callbacks.onTrackAttached === 'function') {
        callbacks.onTrackAttached(clientId, inboundStream, audioEl, event);
      }
    };

    // Isolasi Data Channel (GPS / Telemetri) per `clientId`
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      clientDataChannels[clientId] = channel;

      channel.onmessage = (msgEvent) => {
        let data = msgEvent.data;
        try {
          data = JSON.parse(msgEvent.data);
        } catch (_) {}
        if (typeof callbacks.onDataChannelMessage === 'function') {
          callbacks.onDataChannelMessage(clientId, data, channel);
        }
      };
    };

    // 4. FUNGSI CLEANUP (AUTO-DISCONNECT) SAAT TERPUTUS
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (
        state === 'disconnected' ||
        state === 'failed' ||
        state === 'closed'
      ) {
        cleanupClientConnection(clientId, callbacks);
      }
    };
  }

  // c. Lakukan `setRemoteDescription`, lalu `createAnswer`, dan kirim kembali `Answer` spesifik ke `clientId`
  await pc.setRemoteDescription(new RTCSessionDescription(offer));

  // Masukkan ICE Candidate yang sempat mengantre sebelum RemoteDescription siap
  const queued = pendingIceCandidates[clientId] || [];
  while (queued.length > 0) {
    const candidate = queued.shift();
    if (candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    }
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  signalingChannel.send(
    JSON.stringify({
      type: 'answer',
      senderId: 'master',
      target: clientId,
      clientId: clientId,
      sdp: pc.localDescription,
    })
  );

  return pc;
}

// ============================================================================
// 2B. FUNGSI PENANGANAN ICE CANDIDATE SPESIFIK PER KLIEN
// ============================================================================
export async function handleIncomingIce(clientId, candidate) {
  if (!clientId || !candidate) return;

  const pc = peerConnections[clientId];
  if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
    if (!pendingIceCandidates[clientId]) {
      pendingIceCandidates[clientId] = [];
    }
    pendingIceCandidates[clientId].push(candidate);
    return;
  }

  await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
}

if (typeof window !== 'undefined') {
  window.WebRTCMultiManager = {
    peerConnections,
    clientDataChannels,
    handleIncomingOffer,
    handleIncomingIce,
    cleanupClientConnection,
    ensureAudioContainer,
  };
}
