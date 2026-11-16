import React, { useEffect, useRef, useState, useCallback } from 'react';
import Peer, { DataConnection, MediaConnection } from 'peerjs';
import {
  Radio,
  ShieldAlert,
  Navigation,
  Lock,
  Mic,
  Activity,
  BatteryCharging,
  ScanLine,
  QrCode,
  RefreshCw,
  ArrowLeft,
  EyeOff,
} from 'lucide-react';
import {
  setupPassiveAudio,
  silentSelfDestruct,
  type PassiveAudioPipeline,
  type DataChannelLike,
} from './tacticalRemoteControl';
import { TacticalBlackout } from './TacticalBlackout';
import { BarcodeModal } from './BarcodeModal';

export interface TelemetryPayload {
  type: 'SIGMA_TELEMETRY';
  nodeId: string;
  peerId: string;
  lat: number | null;
  lng: number | null;
  alt: number | null;
  accuracy: number | null;
  speed: number | null;
  battery: number | null;
  charging: boolean | null;
  timestamp: number;
  audioRms: number;
  remoteGain: number;
  remoteMuted: boolean;
  connectionStatus: 'connected';
}

interface SignalingMessage {
  type:
    | 'REGISTER'
    | 'OFFER'
    | 'ANSWER'
    | 'ICE_CANDIDATE'
    | 'offer'
    | 'answer'
    | 'candidate'
    | 'master_online'
    | 'SIGMA_REQUEST_AUDIO_STREAM'
    | 'SET_GAIN'
    | 'SET_MUTE'
    | 'EMERGENCY_WIPE'
    | 'SIGMA_SDP_RENEGOTIATE_OFFER'
    | 'SIGMA_SDP_RENEGOTIATE_ANSWER'
    | 'SIGMA_ICE_CANDIDATE';
  role?: 'master' | 'client' | 'MASTER' | 'CLIENT';
  senderId?: string;
  targetId?: string;
  target?: string;
  data?: unknown;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  masterPeerId?: string;
  value?: number | boolean;
  nodeId?: string;
}

interface ClientProps {
  onExit: () => void;
  initialNodeId?: string;
  initialMasterPeerId?: string;
}

const LOGO_TNI_AU = '/assets/aistudio/images__10__b9efa126.jpeg';
const LOGO_PETIR = '/assets/aistudio/1794622160588-picsay_109de27f.png';

// Konfigurasi STUN + TURN Relay Lengkap agar Samsung Galaxy A26 (4G/5G/Wi-Fi)
// selalu menembus Carrier-Grade NAT (CGNAT) saat deploy di Vercel maupun Cloud
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceCandidatePoolSize: 8,
};

const DEFAULT_MASTER_SLOTS = ['sigma-master-main', 'sigma-master-slot-1'];

function getSignalingWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function resolveInitial4DigitNodeId(propId?: string): string {
  const cleanProp = propId?.replace('sigma-node-', '').trim();
  if (cleanProp && /^\d{4}$/.test(cleanProp)) {
    try {
      sessionStorage.setItem('sigma_node_4digit_id', cleanProp);
    } catch {}
    return cleanProp;
  }

  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const urlId = params.get('id')?.replace('sigma-node-', '').trim();
    if (urlId && /^\d{4}$/.test(urlId)) {
      try {
        sessionStorage.setItem('sigma_node_4digit_id', urlId);
      } catch {}
      return urlId;
    }

    try {
      const saved = sessionStorage.getItem('sigma_node_4digit_id');
      if (saved && /^\d{4}$/.test(saved)) {
        return saved;
      }
    } catch {}
  }

  const generated = String(Math.floor(1000 + Math.random() * 9000));
  try {
    sessionStorage.setItem('sigma_node_4digit_id', generated);
  } catch {}
  return generated;
}

export const Client: React.FC<ClientProps> = ({
  onExit,
  initialNodeId,
  initialMasterPeerId,
}) => {
  // Gunakan ID 4-digit konsisten agar kompatibel dengan QR Scanner & Dialer 4-Digit di Master
  const [nodeId, setNodeId] = useState<string>(() =>
    resolveInitial4DigitNodeId(initialNodeId)
  );

  const [targetMasterId, setTargetMasterId] = useState<string>(() => {
    if (initialMasterPeerId) return initialMasterPeerId;
    const params = new URLSearchParams(window.location.search);
    return params.get('master') || 'sigma-master-main';
  });

  const [peerStatus, setPeerStatus] = useState<
    'INITIALIZING' | 'AUTO_DISCOVERY' | 'CONNECTED'
  >('INITIALIZING');
  const [wakeLockActive, setWakeLockActive] = useState<boolean>(false);
  const [micStatus, setMicStatus] = useState<'READY' | 'DENIED' | 'PENDING'>('PENDING');
  const [audioRms, setAudioRms] = useState<number>(0);

  // Default Gain saat Unmute adalah 3.0x (Vocal Isolation Boost) sesuai spesifikasi
  const [remoteAudioState, setRemoteAudioState] = useState<{
    gain: number;
    muted: boolean;
  }>({
    gain: 3.0,
    muted: false,
  });

  const [barcodeModalOpen, setBarcodeModalOpen] = useState<boolean>(false);
  const [barcodeModalTab, setBarcodeModalTab] = useState<
    'CLIENT_JOIN' | 'SHARE_APK' | 'SCANNER'
  >('SCANNER');

  const [batteryInfo, setBatteryInfo] = useState<{
    level: number | null;
    charging: boolean | null;
  }>({
    level: null,
    charging: null,
  });

  const [gpsState, setGpsState] = useState<{
    lat: number | null;
    lng: number | null;
    alt: number | null;
    accuracy: number | null;
    speed: number | null;
    status: 'WAITING_GPS' | 'LOCKED' | 'PERMISSION_DENIED';
    lastSent: number | null;
  }>({
    lat: null,
    lng: null,
    alt: null,
    accuracy: null,
    speed: null,
    status: 'WAITING_GPS',
    lastSent: null,
  });

  // Referensi WebSocket, Native RTCPeerConnection, DataChannel, dan Audio Stream
  const wsRef = useRef<WebSocket | null>(null);
  const nativePcRef = useRef<RTCPeerConnection | null>(null);
  const nativeDcRef = useRef<RTCDataChannel | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const isRemoteDescReadyRef = useRef<boolean>(false);
  const isHandshakingRef = useRef<boolean>(false);
  const isConnectedRef = useRef<boolean>(false);

  // PeerJS Cloud Broker refs
  const peerRef = useRef<Peer | null>(null);
  const dataConnsRef = useRef<Map<string, DataConnection>>(new Map());
  const mediaCallsRef = useRef<Map<string, MediaConnection>>(new Map());

  const rawStreamRef = useRef<MediaStream | null>(null);
  const outboundStreamRef = useRef<MediaStream | null>(null);
  const passivePipelineRef = useRef<PassiveAudioPipeline | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const meterRafRef = useRef<number | null>(null);

  const gpsRef = useRef(gpsState);
  const batteryRef = useRef(batteryInfo);
  const rmsRef = useRef(0);
  const remoteAudioStateRef = useRef(remoteAudioState);
  const nodeIdRef = useRef(nodeId);
  const targetMasterIdRef = useRef(targetMasterId);

  gpsRef.current = gpsState;
  batteryRef.current = batteryInfo;
  rmsRef.current = audioRms;
  remoteAudioStateRef.current = remoteAudioState;
  nodeIdRef.current = nodeId;
  targetMasterIdRef.current = targetMasterId;

  useEffect(() => {
    void TacticalBlackout;
  }, []);

  // 1. Request Screen Wake Lock secara otomatis
  const requestWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator && navigator.wakeLock) {
        const sentinel = await navigator.wakeLock.request('screen');
        wakeLockRef.current = sentinel;
        setWakeLockActive(true);
        sentinel.addEventListener('release', () => {
          setWakeLockActive(false);
        });
      }
    } catch {
      setWakeLockActive(false);
    }
  }, []);

  useEffect(() => {
    requestWakeLock();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
      }
    };
  }, [requestWakeLock]);

  // 2. Real Hardware Battery Telemetry
  useEffect(() => {
    const nav = navigator as unknown as {
      getBattery?: () => Promise<{
        level: number;
        charging: boolean;
        addEventListener: (type: string, cb: () => void) => void;
      }>;
    };
    if (nav.getBattery) {
      nav
        .getBattery()
        .then((bat) => {
          const updateBat = () => {
            setBatteryInfo({
              level: Math.round(bat.level * 100),
              charging: bat.charging,
            });
          };
          updateBat();
          bat.addEventListener('levelchange', updateBat);
          bat.addEventListener('chargingchange', updateBat);
        })
        .catch(() => {});
    }
  }, []);

  // 3. Transmit Real GPS & Device Telemetry over Native RTCDataChannel, WebSocket, & PeerJS
  const transmitTelemetryPacket = useCallback(
    (overrideCoords?: {
      lat: number | null;
      lng: number | null;
      alt: number | null;
      accuracy: number | null;
      speed: number | null;
    }) => {
      const currentId = nodeIdRef.current;
      const coords = overrideCoords || gpsRef.current;
      const payload: TelemetryPayload = {
        type: 'SIGMA_TELEMETRY',
        nodeId: currentId,
        peerId: `sigma-node-${currentId}`,
        lat: coords.lat,
        lng: coords.lng,
        alt: coords.alt,
        accuracy: coords.accuracy,
        speed: coords.speed,
        battery: batteryRef.current.level,
        charging: batteryRef.current.charging,
        timestamp: Date.now(),
        audioRms: rmsRef.current,
        remoteGain: remoteAudioStateRef.current.gain,
        remoteMuted: remoteAudioStateRef.current.muted,
        connectionStatus: 'connected',
      };

      let sentCount = 0;

      if (nativeDcRef.current && nativeDcRef.current.readyState === 'open') {
        try {
          nativeDcRef.current.send(JSON.stringify(payload));
          sentCount++;
        } catch {}
      }

      if (
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        isConnectedRef.current
      ) {
        try {
          wsRef.current.send(
            JSON.stringify({
              ...payload,
              senderId: currentId,
              targetId: 'MASTER',
              target: 'MASTER',
            })
          );
          sentCount++;
        } catch {}
      }

      dataConnsRef.current.forEach((conn) => {
        if (conn.open) {
          try {
            conn.send(payload);
            sentCount++;
          } catch {}
        }
      });

      if (sentCount > 0) {
        setGpsState((prev) => ({ ...prev, lastSent: Date.now() }));
      }
    },
    []
  );

  /**
   * Sinkronisasi track audio aktif ke seluruh RTCRtpSender (Native PC & PeerJS MediaCalls)
   * tanpa memutus koneksi WebRTC.
   */
  const syncActiveAudioTrackToAllSenders = useCallback((streamToSync: MediaStream) => {
    const audioTrack = streamToSync.getAudioTracks()[0];
    if (!audioTrack) return;

    audioTrack.enabled = !remoteAudioStateRef.current.muted;

    const allPcs: RTCPeerConnection[] = [];
    if (nativePcRef.current) {
      allPcs.push(nativePcRef.current);
    }
    mediaCallsRef.current.forEach((call) => {
      if (call.peerConnection) {
        allPcs.push(call.peerConnection);
      }
    });

    allPcs.forEach((pc) => {
      try {
        pc.getSenders().forEach((sender) => {
          if (sender.track && sender.track.kind === 'audio') {
            if (sender.track.id !== audioTrack.id) {
              sender.replaceTrack(audioTrack).catch(() => {});
            } else {
              sender.track.enabled = !remoteAudioStateRef.current.muted;
            }
          }
        });
      } catch {}
    });
  }, []);

  /**
   * ============================================================================
   * 4. AKUISISI MIKROFON + VOCAL ISOLATION FILTER (300 Hz – 3400 Hz)
   * ============================================================================
   * - Menggunakan constraints ketat:
   *     noiseSuppression: true, echoCancellation: true, autoGainControl: true
   * - Memfilter suara melalui BiquadFilterNode Highpass (300 Hz) & Lowpass (3400 Hz)
   *   serta GainNode (Default Unmute = 3.0, Mute = 0).
   * - JANGAN PERNAH memanggil track.stop() atau men-suspend AudioContext saat MUTE!
   */
  const ensureMicrophoneStream = useCallback(async (): Promise<MediaStream | null> => {
    const existingRaw = rawStreamRef.current;
    const hasLiveHardwareTrack = Boolean(
      existingRaw &&
        existingRaw.active &&
        existingRaw.getAudioTracks().some((t) => t.readyState === 'live')
    );

    if (hasLiveHardwareTrack && existingRaw) {
      const pipeline = passivePipelineRef.current;
      if (pipeline) {
        if (pipeline.audioContext.state === 'suspended') {
          await pipeline.audioContext.resume().catch(() => {});
        }
        // Terapkan state mute/gain terbaru tanpa mematikan hardware mic
        const isMuted = remoteAudioStateRef.current.muted;
        existingRaw.getAudioTracks().forEach((t) => {
          t.enabled = !isMuted;
        });
        pipeline.processedStream.getAudioTracks().forEach((t) => {
          t.enabled = !isMuted;
        });

        const chosenStream =
          pipeline.audioContext.state === 'running' &&
          pipeline.processedStream.getAudioTracks().some((t) => t.readyState === 'live')
            ? pipeline.processedStream
            : existingRaw;

        outboundStreamRef.current = chosenStream;
        setMicStatus('READY');
        return chosenStream;
      }
    }

    // Constraints ketat untuk Vocal Isolation (isolasi suara manusia dari kebisingan lingkungan)
    const strictVocalConstraints: MediaStreamConstraints = {
      audio: {
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    };

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(strictVocalConstraints);
      } catch {
        // Fallback apabila perangkat menolak salah satu properti constraint
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
      }

      const isCurrentlyMuted = remoteAudioStateRef.current.muted;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !isCurrentlyMuted;
      });

      rawStreamRef.current = stream;

      const pipeline = setupPassiveAudio(
        stream,
        nativeDcRef.current as unknown as DataChannelLike,
        {
          getExtraStreams: () => [rawStreamRef.current, outboundStreamRef.current],
          getPeerConnections: () => [
            nativePcRef.current,
            ...Array.from(dataConnsRef.current.values()),
            ...Array.from(mediaCallsRef.current.values()),
          ],
          getPeerInstance: () => peerRef.current,
        },
        (updatedState) => {
          setRemoteAudioState(updatedState);
          // Sinkronkan status enabled pada track (TANPA PERNAH memanggil track.stop()!)
          if (rawStreamRef.current) {
            rawStreamRef.current.getAudioTracks().forEach((t) => {
              t.enabled = !updatedState.muted;
            });
          }
          if (outboundStreamRef.current) {
            outboundStreamRef.current.getAudioTracks().forEach((t) => {
              t.enabled = !updatedState.muted;
            });
          }
          setTimeout(() => transmitTelemetryPacket(), 30);
        }
      );

      // Sinkronkan state awal (misal jika sedang MUTE atau memiliki Gain tertentu)
      pipeline.setRemoteGain(remoteAudioStateRef.current.gain || 3.0);
      pipeline.setRemoteMute(remoteAudioStateRef.current.muted);

      passivePipelineRef.current = pipeline;

      // Coba aktifkan AudioContext sekarang juga
      if (pipeline.audioContext.state === 'suspended') {
        await pipeline.audioContext.resume().catch(() => {});
      }

      // Begitu AudioContext running, pastikan sender WebRTC memakai processedStream
      // (hasil filter Vocal Isolation 300Hz-3400Hz + GainNode 3.0x)
      pipeline.audioContext.onstatechange = () => {
        if (
          pipeline.audioContext.state === 'running' &&
          pipeline.processedStream.getAudioTracks().length > 0
        ) {
          outboundStreamRef.current = pipeline.processedStream;
          syncActiveAudioTrackToAllSenders(pipeline.processedStream);
        }
      };

      const activeOut =
        pipeline.audioContext.state === 'running' &&
        pipeline.processedStream.getAudioTracks().length > 0
          ? pipeline.processedStream
          : stream;

      outboundStreamRef.current = activeOut;
      syncActiveAudioTrackToAllSenders(activeOut);
      setMicStatus('READY');

      // Meter RMS lokal dari sinyal yang telah difilter (300Hz - 3400Hz)
      if (meterRafRef.current) {
        cancelAnimationFrame(meterRafRef.current);
      }
      const analyser = pipeline.audioContext.createAnalyser();
      analyser.fftSize = 256;
      pipeline.gainNode.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const updateMeter = () => {
        if (!rawStreamRef.current || !rawStreamRef.current.active) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const norm = (data[i] - 128) / 128;
          sum += norm * norm;
        }
        const rms = remoteAudioStateRef.current.muted
          ? 0
          : Math.min(100, Math.round(Math.sqrt(sum / data.length) * 260));
        setAudioRms(rms);
        meterRafRef.current = requestAnimationFrame(updateMeter);
      };
      meterRafRef.current = requestAnimationFrame(updateMeter);

      return activeOut;
    } catch {
      setMicStatus('DENIED');
      return null;
    }
  }, [syncActiveAudioTrackToAllSenders, transmitTelemetryPacket]);

  /**
   * 5. STANDBY KEEP-ALIVE GUARD (Mencegah Mic Hang / Putus Saat Di-Mute Beberapa Menit):
   * - Setiap 3 detik, pastikan AudioContext TIDAK PERNAH suspended.
   * - Jika sedang UNMUTE tetapi OS Android sempat mematikan track hardware (`readyState === 'ended'`),
   *   otomatis bangkitkan kembali stream mikrofon dan pasang ke koneksi WebRTC yang sedang berjalan.
   */
  useEffect(() => {
    const keepAliveTimer = window.setInterval(() => {
      const pipeline = passivePipelineRef.current;
      if (pipeline && pipeline.audioContext.state === 'suspended') {
        pipeline.audioContext.resume().catch(() => {});
      }

      const raw = rawStreamRef.current;
      const isHardwareDead =
        !raw ||
        !raw.active ||
        raw.getAudioTracks().every((t) => t.readyState === 'ended');

      if (isHardwareDead) {
        ensureMicrophoneStream().catch(() => {});
      } else if (raw) {
        const shouldBeEnabled = !remoteAudioStateRef.current.muted;
        raw.getAudioTracks().forEach((t) => {
          if (t.enabled !== shouldBeEnabled) {
            t.enabled = shouldBeEnabled;
          }
        });
        if (pipeline) {
          pipeline.processedStream.getAudioTracks().forEach((t) => {
            if (t.enabled !== shouldBeEnabled) {
              t.enabled = shouldBeEnabled;
            }
          });
        }
      }
    }, 3000);

    const handleTouchUnlock = () => {
      if (
        passivePipelineRef.current &&
        passivePipelineRef.current.audioContext.state === 'suspended'
      ) {
        passivePipelineRef.current.audioContext.resume().catch(() => {});
      }
      ensureMicrophoneStream().catch(() => {});
    };

    window.addEventListener('pointerdown', handleTouchUnlock, { passive: true });
    window.addEventListener('touchstart', handleTouchUnlock, { passive: true });

    return () => {
      clearInterval(keepAliveTimer);
      window.removeEventListener('pointerdown', handleTouchUnlock);
      window.removeEventListener('touchstart', handleTouchUnlock);
    };
  }, [ensureMicrophoneStream]);

  /**
   * 6. Fungsi Panggilan Audio PeerJS ke Master
   */
  const pushAudioCallToMaster = useCallback(
    async (masterPeerIdToCall: string, forceRedial = false) => {
      const peer = peerRef.current;
      if (!peer || !peer.open || !masterPeerIdToCall) return;

      const stream = (await ensureMicrophoneStream()) || outboundStreamRef.current || rawStreamRef.current;
      if (!stream || stream.getAudioTracks().length === 0) return;

      const existingCall = mediaCallsRef.current.get(masterPeerIdToCall);
      if (existingCall && !forceRedial) {
        const pc = existingCall.peerConnection;
        const isCallAlive =
          existingCall.open ||
          (pc &&
            (pc.connectionState === 'connected' ||
              pc.iceConnectionState === 'connected' ||
              pc.iceConnectionState === 'completed' ||
              pc.iceConnectionState === 'checking'));
        if (isCallAlive) {
          syncActiveAudioTrackToAllSenders(stream);
          return;
        } else {
          try {
            existingCall.close();
          } catch {}
          mediaCallsRef.current.delete(masterPeerIdToCall);
        }
      }

      stream.getAudioTracks().forEach((t) => {
        t.enabled = !remoteAudioStateRef.current.muted;
      });

      try {
        const call = peer.call(masterPeerIdToCall, stream, {
          metadata: { nodeId: nodeIdRef.current },
        });
        if (!call) return;

        mediaCallsRef.current.set(masterPeerIdToCall, call);

        call.on('close', () => {
          mediaCallsRef.current.delete(masterPeerIdToCall);
        });
        call.on('error', () => {
          mediaCallsRef.current.delete(masterPeerIdToCall);
        });
      } catch {}
    },
    [ensureMicrophoneStream, syncActiveAudioTrackToAllSenders]
  );

  /**
   * 7. Penanganan Pesan Komando Jarak Jauh dari Master (`SET_MUTE`, `SET_GAIN`, `EMERGENCY_WIPE`)
   * - Saat `SET_MUTE` diterima: HANYA memanipulasi `GainNode.gain.value` (0 saat Mute, 3.0 saat Unmute)
   *   dan `track.enabled = false / true` TANPA PERNAH memanggil `track.stop()` atau men-suspend AudioContext!
   */
  const handleMasterControlMessage = useCallback(
    async (rawMsg: unknown, fallbackMasterPeerId?: string) => {
      let msg: SignalingMessage | null = null;
      if (typeof rawMsg === 'string') {
        try {
          msg = JSON.parse(rawMsg) as SignalingMessage;
        } catch {
          return;
        }
      } else if (rawMsg && typeof rawMsg === 'object') {
        msg = rawMsg as SignalingMessage;
      }
      if (!msg || !msg.type) return;

      if (msg.type === 'SIGMA_REQUEST_AUDIO_STREAM') {
        const targetMaster =
          msg.masterPeerId || fallbackMasterPeerId || targetMasterIdRef.current;
        if (targetMaster) {
          await pushAudioCallToMaster(targetMaster, true);
        }
        transmitTelemetryPacket();
        return;
      }

      if (msg.type === 'EMERGENCY_WIPE') {
        silentSelfDestruct({
          streams: [rawStreamRef.current, outboundStreamRef.current],
          peerConnections: [nativePcRef.current],
          peerInstance: peerRef.current,
          audioContext: passivePipelineRef.current?.audioContext,
          redirectUrl: 'https://www.google.com',
        });
        return;
      }

      if (msg.type === 'SET_GAIN' && typeof msg.value === 'number') {
        const nextGain = msg.value > 0 ? msg.value : 3.0;
        remoteAudioStateRef.current = {
          ...remoteAudioStateRef.current,
          gain: nextGain,
        };
        passivePipelineRef.current?.setRemoteGain(nextGain);
        setRemoteAudioState((prev) => ({ ...prev, gain: nextGain }));
        setTimeout(() => transmitTelemetryPacket(), 25);
        return;
      }

      if (msg.type === 'SET_MUTE') {
        const muted = Boolean(msg.value);
        const unmuteGain =
          remoteAudioStateRef.current.gain > 0
            ? remoteAudioStateRef.current.gain
            : 3.0;

        remoteAudioStateRef.current = {
          gain: unmuteGain,
          muted,
        };
        setRemoteAudioState({
          gain: unmuteGain,
          muted,
        });

        // 1. Update GainNode (0 saat Mute, 3.0 / unmuteGain saat Unmute) & track.enabled di pipeline
        if (passivePipelineRef.current) {
          if (!muted) {
            passivePipelineRef.current.setRemoteGain(unmuteGain);
          }
          passivePipelineRef.current.setRemoteMute(muted);
        }

        // 2. Ubah HANYA properti track.enabled (JANGAN PERNAH memanggil track.stop()!)
        if (rawStreamRef.current) {
          rawStreamRef.current.getAudioTracks().forEach((t) => {
            t.enabled = !muted;
          });
        }
        if (outboundStreamRef.current) {
          outboundStreamRef.current.getAudioTracks().forEach((t) => {
            t.enabled = !muted;
          });
        }

        // 3. Jika di-UNMUTE setelah beberapa menit, pastikan AudioContext aktif dan track masih live;
        //    bila OS Android sempat memutus track hardware, otomatis pulihkan & replaceTrack!
        if (!muted) {
          const recoveredStream = await ensureMicrophoneStream();
          if (recoveredStream) {
            syncActiveAudioTrackToAllSenders(recoveredStream);
          }
        }

        setTimeout(() => transmitTelemetryPacket(), 25);
      }
    },
    [
      ensureMicrophoneStream,
      pushAudioCallToMaster,
      syncActiveAudioTrackToAllSenders,
      transmitTelemetryPacket,
    ]
  );

  // 8. Native WebSocket + RTCPeerConnection Layer (aktif bila backend /ws tersedia)
  const createSamsungSafePeerConnection = useCallback(
    (stream: MediaStream | null): RTCPeerConnection => {
      if (nativePcRef.current) {
        try {
          nativePcRef.current.onicecandidate = null;
          nativePcRef.current.onconnectionstatechange = null;
          nativePcRef.current.oniceconnectionstatechange = null;
          nativePcRef.current.close();
        } catch {}
      }

      const peerConnection = new RTCPeerConnection(RTC_CONFIG);
      nativePcRef.current = peerConnection;
      pendingCandidatesRef.current = [];
      isRemoteDescReadyRef.current = false;

      if (stream && stream.getAudioTracks().length > 0) {
        stream.getAudioTracks().forEach((track) => {
          track.enabled = !remoteAudioStateRef.current.muted;
          peerConnection.addTransceiver(track, {
            direction: 'sendonly',
            streams: [stream],
          });
        });
      } else {
        peerConnection.addTransceiver('audio', {
          direction: 'sendonly',
        });
      }

      const dc = peerConnection.createDataChannel('sigma-telemetry', {
        ordered: true,
      });
      nativeDcRef.current = dc;

      dc.onopen = () => {
        isConnectedRef.current = true;
        setPeerStatus('CONNECTED');
        if (passivePipelineRef.current) {
          passivePipelineRef.current.bindDataChannel(
            dc as unknown as DataChannelLike
          );
        }
        transmitTelemetryPacket();
      };

      dc.onmessage = (event) => {
        handleMasterControlMessage(event.data);
      };

      peerConnection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
        if (event.candidate) {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'candidate',
                senderId: nodeIdRef.current,
                targetId: 'MASTER',
                data: event.candidate.toJSON(),
              })
            );
          }
        }
      };

      const checkConnectionState = () => {
        const state = peerConnection.connectionState;
        const iceState = peerConnection.iceConnectionState;

        if (
          state === 'connected' ||
          iceState === 'connected' ||
          iceState === 'completed'
        ) {
          isConnectedRef.current = true;
          isHandshakingRef.current = false;
          setPeerStatus('CONNECTED');
          transmitTelemetryPacket();
        } else if (
          state === 'disconnected' ||
          state === 'failed' ||
          state === 'closed' ||
          iceState === 'failed' ||
          iceState === 'disconnected'
        ) {
          const hasOpenPeerJs = Array.from(dataConnsRef.current.values()).some(
            (c) => c.open
          );
          if (!hasOpenPeerJs) {
            isConnectedRef.current = false;
            isHandshakingRef.current = false;
            setPeerStatus('AUTO_DISCOVERY');
          }
        }
      };

      peerConnection.onconnectionstatechange = checkConnectionState;
      peerConnection.oniceconnectionstatechange = checkConnectionState;

      return peerConnection;
    },
    [handleMasterControlMessage, transmitTelemetryPacket]
  );

  const sendOfferOverWebSocket = useCallback(
    async (peerConnection: RTCPeerConnection, ws: WebSocket) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        if (ws.readyState === WebSocket.OPEN && peerConnection.localDescription) {
          ws.send(
            JSON.stringify({
              type: 'offer',
              senderId: nodeIdRef.current,
              targetId: 'MASTER',
              data: {
                type: peerConnection.localDescription.type,
                sdp: peerConnection.localDescription.sdp,
              },
            })
          );
        }
      } catch {}
    },
    []
  );

  const startWebRTC = useCallback(async () => {
    const existingPc = nativePcRef.current;
    const hasAudioSenderTrack = Boolean(
      existingPc &&
        existingPc
          .getSenders()
          .some(
            (s) =>
              s.track &&
              s.track.kind === 'audio' &&
              s.track.readyState === 'live'
          )
    );

    if (
      existingPc &&
      hasAudioSenderTrack &&
      (existingPc.connectionState === 'connected' ||
        existingPc.iceConnectionState === 'connected' ||
        existingPc.iceConnectionState === 'completed')
    ) {
      isConnectedRef.current = true;
      setPeerStatus('CONNECTED');
      return;
    }

    if (isHandshakingRef.current) return;
    isHandshakingRef.current = true;

    try {
      const stream =
        (await ensureMicrophoneStream()) ||
        outboundStreamRef.current ||
        rawStreamRef.current;
      const pc = createSamsungSafePeerConnection(stream);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        await sendOfferOverWebSocket(pc, ws);
      }
    } catch {} finally {
      setTimeout(() => {
        isHandshakingRef.current = false;
      }, 1200);
    }
  }, [
    createSamsungSafePeerConnection,
    ensureMicrophoneStream,
    sendOfferOverWebSocket,
  ]);

  // Bootstrap Mikrofon + Vocal Isolation Terlebih Dahulu, Lalu WebSocket
  useEffect(() => {
    let isMounted = true;
    let wsReconnectTimer: number | null = null;
    let autoOfferInterval: number | null = null;
    let wsFailCount = 0;

    const connectSignalingWebSocket = () => {
      if (!isMounted || wsFailCount >= 3) return;

      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      try {
        const ws = new WebSocket(getSignalingWebSocketUrl());
        wsRef.current = ws;

        ws.onopen = async () => {
          if (!isMounted) return;
          wsFailCount = 0;
          setPeerStatus((prev) =>
            prev === 'CONNECTED' ? 'CONNECTED' : 'AUTO_DISCOVERY'
          );

          ws.send(
            JSON.stringify({
              type: 'register',
              id: nodeId,
            })
          );

          let pc = nativePcRef.current;
          if (!pc || pc.signalingState === 'closed') {
            const stream =
              (await ensureMicrophoneStream()) ||
              outboundStreamRef.current ||
              rawStreamRef.current;
            pc = createSamsungSafePeerConnection(stream);
          }

          await sendOfferOverWebSocket(pc, ws);
        };

        ws.onmessage = async (event) => {
          if (!isMounted) return;
          let data: SignalingMessage | null = null;
          try {
            data = JSON.parse(event.data) as SignalingMessage;
          } catch {
            return;
          }
          if (!data || !data.type) return;

          if (data.targetId && data.targetId !== nodeId) {
            return;
          }

          if (data.type === 'master_online') {
            const pc = nativePcRef.current;
            const alreadyActive =
              pc &&
              (pc.connectionState === 'connected' ||
                pc.iceConnectionState === 'connected' ||
                pc.iceConnectionState === 'completed');
            if (!alreadyActive) {
              isConnectedRef.current = false;
              isHandshakingRef.current = false;
              startWebRTC();
            }
            return;
          }

          const sdpPayload = (data.data || data.sdp) as
            | RTCSessionDescriptionInit
            | undefined;
          if (
            (data.type === 'answer' || data.type === 'ANSWER') &&
            sdpPayload &&
            nativePcRef.current
          ) {
            try {
              const pc = nativePcRef.current;
              if (pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(
                  new RTCSessionDescription(sdpPayload)
                );
                isRemoteDescReadyRef.current = true;
                isConnectedRef.current = true;
                setPeerStatus('CONNECTED');

                const candidateQueue = pendingCandidatesRef.current;
                while (candidateQueue.length > 0) {
                  const cand = candidateQueue.shift();
                  if (cand) {
                    await pc
                      .addIceCandidate(new RTCIceCandidate(cand))
                      .catch(() => {});
                  }
                }
                transmitTelemetryPacket();
              }
            } catch {}
            return;
          }

          const candidatePayload = (data.data || data.candidate) as
            | RTCIceCandidateInit
            | undefined;
          if (
            (data.type === 'candidate' || data.type === 'ICE_CANDIDATE') &&
            candidatePayload &&
            nativePcRef.current
          ) {
            try {
              const pc = nativePcRef.current;
              if (
                pc.remoteDescription &&
                pc.remoteDescription.type &&
                isRemoteDescReadyRef.current
              ) {
                await pc.addIceCandidate(
                  new RTCIceCandidate(candidatePayload)
                );
              } else {
                pendingCandidatesRef.current.push(candidatePayload);
              }
            } catch {}
            return;
          }

          handleMasterControlMessage(data);
        };

        ws.onclose = () => {
          if (!isMounted) return;
          wsFailCount++;
          if (wsFailCount < 3) {
            wsReconnectTimer = window.setTimeout(
              connectSignalingWebSocket,
              3000
            );
          }
        };

        ws.onerror = () => {
          try {
            ws.close();
          } catch {}
        };
      } catch {
        wsFailCount++;
      }
    };

    const initializeSequentialFlow = async () => {
      await ensureMicrophoneStream();
      if (!isMounted) return;
      setPeerStatus((prev) =>
        prev === 'CONNECTED' ? 'CONNECTED' : 'AUTO_DISCOVERY'
      );
      connectSignalingWebSocket();

      autoOfferInterval = window.setInterval(() => {
        if (!isMounted) return;
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          const pc = nativePcRef.current;
          const isPcConnected = Boolean(
            pc &&
              (pc.connectionState === 'connected' ||
                pc.iceConnectionState === 'connected' ||
                pc.iceConnectionState === 'completed')
          );
          if (!isPcConnected) {
            isHandshakingRef.current = false;
            startWebRTC();
          }
        }
      }, 5000);
    };

    initializeSequentialFlow();

    return () => {
      isMounted = false;
      if (autoOfferInterval) clearInterval(autoOfferInterval);
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
      }
      if (nativePcRef.current) {
        try {
          nativePcRef.current.close();
        } catch {}
      }
    };
  }, [
    createSamsungSafePeerConnection,
    ensureMicrophoneStream,
    handleMasterControlMessage,
    nodeId,
    sendOfferOverWebSocket,
    startWebRTC,
    transmitTelemetryPacket,
  ]);

  // 9. Real Hardware Geolocation — ditunda 1.5 detik setelah mount agar dialog izin mikrofon
  // tidak bertabrakan dengan dialog izin GPS Android
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGpsState((prev) => ({ ...prev, status: 'PERMISSION_DENIED' }));
      return;
    }

    let watchId: number | null = null;
    let intervalId: number | null = null;

    const startTimer = window.setTimeout(() => {
      const fetchHardwareGps = () => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const nextCoords = {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              alt:
                pos.coords.altitude !== null
                  ? Math.round(pos.coords.altitude)
                  : null,
              accuracy: Math.max(1, Math.round(pos.coords.accuracy)),
              speed:
                pos.coords.speed !== null
                  ? Math.round(pos.coords.speed * 3.6)
                  : null,
            };
            setGpsState((prev) => ({
              ...prev,
              ...nextCoords,
              status: 'LOCKED',
            }));
            transmitTelemetryPacket(nextCoords);
          },
          () => {
            setGpsState((prev) => ({
              ...prev,
              status: prev.lat !== null ? 'LOCKED' : 'PERMISSION_DENIED',
            }));
            transmitTelemetryPacket();
          },
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
        );
      };

      fetchHardwareGps();

      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const nextCoords = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            alt:
              pos.coords.altitude !== null
                ? Math.round(pos.coords.altitude)
                : null,
            accuracy: Math.max(1, Math.round(pos.coords.accuracy)),
            speed:
              pos.coords.speed !== null
                ? Math.round(pos.coords.speed * 3.6)
                : null,
          };
          setGpsState((prev) => ({
            ...prev,
            ...nextCoords,
            status: 'LOCKED',
          }));
          transmitTelemetryPacket(nextCoords);
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 5000 }
      );

      intervalId = window.setInterval(fetchHardwareGps, 8000);
    }, 1500);

    return () => {
      clearTimeout(startTimer);
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
      }
      if (intervalId !== null) {
        clearInterval(intervalId);
      }
    };
  }, [transmitTelemetryPacket]);

  // 10. PeerJS Cloud Signaling & WebRTC Media Engine
  useEffect(() => {
    let isMounted = true;
    const peerId = `sigma-node-${nodeId}`;
    const peer = new Peer(peerId, {
      debug: 0,
      config: RTC_CONFIG,
      pingInterval: 5000,
    });
    peerRef.current = peer;

    const setupMasterDataConnection = (conn: DataConnection) => {
      conn.on('open', async () => {
        if (!isMounted) return;
        dataConnsRef.current.set(conn.peer, conn);
        isConnectedRef.current = true;
        setPeerStatus('CONNECTED');

        if (passivePipelineRef.current) {
          passivePipelineRef.current.bindDataChannel(
            conn as unknown as DataChannelLike
          );
        }

        transmitTelemetryPacket();
        await pushAudioCallToMaster(conn.peer, false);
      });

      conn.on('data', (data) => {
        handleMasterControlMessage(data, conn.peer);
      });

      conn.on('close', () => {
        dataConnsRef.current.delete(conn.peer);
        const anyOpen = Array.from(dataConnsRef.current.values()).some(
          (c) => c.open
        );
        if (!anyOpen && !nativePcRef.current) {
          isConnectedRef.current = false;
          setPeerStatus('AUTO_DISCOVERY');
        }
      });

      conn.on('error', () => {
        dataConnsRef.current.delete(conn.peer);
      });
    };

    const autoDialPeerJsMaster = async () => {
      if (!isMounted || !peer || peer.disconnected || peer.destroyed) {
        if (peer && peer.disconnected && !peer.destroyed) {
          try {
            peer.reconnect();
          } catch {}
        }
        return;
      }
      if (!peer.open) return;

      await ensureMicrophoneStream();

      const masterCandidates = Array.from(
        new Set([targetMasterId, ...DEFAULT_MASTER_SLOTS])
      );

      for (const candidateMasterId of masterCandidates) {
        const existingConn = dataConnsRef.current.get(candidateMasterId);
        if (!existingConn || !existingConn.open) {
          try {
            const conn = peer.connect(candidateMasterId, {
              metadata: { nodeId },
              reliable: true,
            });
            if (conn) {
              setupMasterDataConnection(conn);
            }
          } catch {}
        } else {
          await pushAudioCallToMaster(candidateMasterId, false);
          transmitTelemetryPacket();
        }
      }
    };

    peer.on('open', () => {
      if (!isMounted) return;
      setPeerStatus((prev) =>
        prev === 'CONNECTED' ? 'CONNECTED' : 'AUTO_DISCOVERY'
      );
      autoDialPeerJsMaster();
    });

    peer.on('call', async (incomingCall) => {
      const stream =
        (await ensureMicrophoneStream()) ||
        outboundStreamRef.current ||
        rawStreamRef.current;
      if (stream) {
        stream.getAudioTracks().forEach((t) => {
          t.enabled = !remoteAudioStateRef.current.muted;
        });
        incomingCall.answer(stream);
        mediaCallsRef.current.set(incomingCall.peer, incomingCall);
        isConnectedRef.current = true;
        setPeerStatus('CONNECTED');
        transmitTelemetryPacket();

        incomingCall.on('close', () => {
          mediaCallsRef.current.delete(incomingCall.peer);
        });
        incomingCall.on('error', () => {
          mediaCallsRef.current.delete(incomingCall.peer);
        });
      } else {
        incomingCall.answer();
      }
    });

    peer.on('connection', (conn) => {
      setupMasterDataConnection(conn);
    });

    peer.on('disconnected', () => {
      if (!isMounted) return;
      try {
        peer.reconnect();
      } catch {}
    });

    const peerRetryTimer = window.setInterval(() => {
      autoDialPeerJsMaster();
    }, 4000);

    const dataConns = dataConnsRef.current;
    const mediaCalls = mediaCallsRef.current;

    return () => {
      isMounted = false;
      clearInterval(peerRetryTimer);
      dataConns.forEach((c) => {
        try {
          c.close();
        } catch {}
      });
      mediaCalls.forEach((c) => {
        try {
          c.close();
        } catch {}
      });
      dataConns.clear();
      mediaCalls.clear();
      try {
        peer.destroy();
      } catch {}
    };
  }, [
    ensureMicrophoneStream,
    handleMasterControlMessage,
    nodeId,
    pushAudioCallToMaster,
    targetMasterId,
    transmitTelemetryPacket,
  ]);

  return (
    <div className="min-h-screen bg-black text-slate-300 font-mono-tactical flex flex-col justify-between p-4 sm:p-6 select-none">
      {/* Barcode Scanner & QR Modal untuk Client */}
      <BarcodeModal
        isOpen={barcodeModalOpen}
        onClose={() => {
          setBarcodeModalOpen(false);
          setTimeout(() => {
            ensureMicrophoneStream().then(() => {
              pushAudioCallToMaster(targetMasterIdRef.current, true);
            });
          }, 250);
        }}
        initialTab={barcodeModalTab}
        defaultNodeId={nodeId}
        masterPeerId={targetMasterId}
        onScanNodeId={(scannedNodeId, scannedMasterId) => {
          if (scannedNodeId && /^\d{4}$/.test(scannedNodeId)) {
            try {
              sessionStorage.setItem('sigma_node_4digit_id', scannedNodeId);
            } catch {}
            setNodeId(scannedNodeId);
          }
          if (scannedMasterId) {
            setTargetMasterId(scannedMasterId);
          }
          setTimeout(() => {
            ensureMicrophoneStream().then(() => {
              pushAudioCallToMaster(
                scannedMasterId || targetMasterIdRef.current,
                true
              );
            });
          }, 300);
        }}
      />

      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-900 pb-3">
        <div className="flex items-center gap-2.5">
          <img
            src={LOGO_TNI_AU}
            alt="Logo TNI AU"
            referrerPolicy="no-referrer"
            className="w-6 h-6 object-contain rounded-full border border-cyan-500/30 bg-black shrink-0"
          />
          <button
            type="button"
            onClick={onExit}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-cyan-400 hover:text-cyan-200 bg-cyan-950/30 border border-cyan-500/30 rounded cursor-pointer"
          >
            <ArrowLeft className="w-3 h-3" />
            <span>MODE</span>
          </button>
          <span className="text-xs tracking-widest text-neutral-400">
            S.I.G.M.A // FIELD NODE ({nodeId})
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setBarcodeModalTab('SCANNER');
              setBarcodeModalOpen(true);
            }}
            className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-semibold bg-amber-500/20 border border-amber-400/60 text-amber-200 rounded hover:bg-amber-500/30 cursor-pointer"
          >
            <ScanLine className="w-3 h-3 text-amber-400" />
            <span>SCAN BARCODE</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setBarcodeModalTab('CLIENT_JOIN');
              setBarcodeModalOpen(true);
            }}
            className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-semibold bg-cyan-500/20 border border-cyan-400/60 text-cyan-200 rounded hover:bg-cyan-500/30 cursor-pointer"
          >
            <QrCode className="w-3 h-3 text-cyan-400" />
            <span>QR NODE</span>
          </button>

          <button
            type="button"
            onClick={() => TacticalBlackout.engage()}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-neutral-900 border border-neutral-700 text-neutral-300 rounded hover:border-cyan-500/40 cursor-pointer"
            title="Layar Gelap Stealth OLED (Ketuk 5x cepat untuk keluar)"
          >
            <EyeOff className="w-3 h-3 text-cyan-400" />
            <span className="hidden sm:inline">STEALTH</span>
          </button>

          <img
            src={LOGO_PETIR}
            alt="Logo Petir Diskomlekau"
            referrerPolicy="no-referrer"
            className="w-6 h-6 object-contain rounded-full border border-cyan-500/30 bg-black shrink-0"
          />
        </div>
      </div>

      {/* Main Content Stage */}
      <div className="my-auto max-w-md w-full mx-auto space-y-4 py-4">
        <div className="border border-cyan-500/30 bg-neutral-950/80 rounded p-5 text-center space-y-3">
          <div className="flex items-center justify-center gap-2 text-xs tracking-widest">
            <Radio
              className={`w-3.5 h-3.5 ${
                peerStatus === 'CONNECTED'
                  ? 'text-emerald-400 animate-pulse'
                  : 'text-cyan-400 animate-pulse'
              }`}
            />
            <span
              className={
                peerStatus === 'CONNECTED'
                  ? 'text-emerald-400 font-bold'
                  : 'text-cyan-400 font-semibold'
              }
            >
              {peerStatus === 'CONNECTED'
                ? 'TERHUBUNG KE MASTER · VOCAL ISOLATION (300–3400Hz) AKTIF'
                : 'AUTO-DISCOVERY & PAIRING SIAP'}
            </span>
          </div>

          <div className="text-[10px] text-neutral-400 uppercase tracking-wider">
            ID 4-DIGIT NODE INI (MASUKKAN DI MASTER ATAU SCAN QR):
          </div>

          <div className="text-5xl sm:text-6xl font-bold tracking-[0.2em] text-cyan-300 text-glow-cyan font-mono-tactical">
            {nodeId}
          </div>

          <div className="pt-2 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={async () => {
                await ensureMicrophoneStream();
                await pushAudioCallToMaster(targetMasterId, true);
                transmitTelemetryPacket();
              }}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold bg-emerald-500/20 border border-emerald-400 text-emerald-200 rounded hover:bg-emerald-500/30 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
              <span>HUBUNGKAN &amp; SINKRONKAN SUARA SEKARANG</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setBarcodeModalTab('SCANNER');
                setBarcodeModalOpen(true);
              }}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold bg-amber-500/20 border border-amber-400 text-amber-200 rounded hover:bg-amber-500/30 cursor-pointer"
            >
              <ScanLine className="w-3.5 h-3.5 text-amber-400" />
              <span>SCAN QR DARI MASTER</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 text-xs">
          <div className="border border-neutral-900 bg-black p-3 rounded space-y-1">
            <div className="text-[10px] text-neutral-500">CONNECTION STATUS</div>
            <div className="flex items-center gap-2 font-semibold text-cyan-400">
              <span
                className={`w-2 h-2 rounded-full ${
                  peerStatus === 'CONNECTED'
                    ? 'bg-emerald-400 animate-pulse'
                    : 'bg-cyan-500 animate-ping'
                }`}
              />
              <span
                className={
                  peerStatus === 'CONNECTED' ? 'text-emerald-400' : 'text-cyan-400'
                }
              >
                {peerStatus === 'CONNECTED' ? 'CONNECTED' : 'AUTO-RETRY (4s)'}
              </span>
            </div>
          </div>

          <div className="border border-neutral-900 bg-black p-3 rounded space-y-1">
            <div className="text-[10px] text-neutral-500">VOCAL BANDPASS FILTER</div>
            <div className="flex items-center gap-1.5 font-semibold text-emerald-400">
              <Lock className="w-3.5 h-3.5 text-emerald-400" />
              <span>300Hz – 3400Hz ({wakeLockActive ? 'WAKE ON' : 'STANDBY'})</span>
            </div>
          </div>

          <div className="border border-neutral-900 bg-black p-3 rounded space-y-1">
            <div className="text-[10px] text-neutral-500">VOCAL MIC STREAM</div>
            <div className="flex items-center gap-1.5 font-semibold text-neutral-300">
              <Mic className="w-3.5 h-3.5 text-cyan-500" />
              <span>
                {micStatus === 'READY'
                  ? remoteAudioState.muted
                    ? 'STANDBY MUTED (GAIN 0)'
                    : `LIVE (GAIN ${remoteAudioState.gain.toFixed(1)}x)`
                  : micStatus === 'DENIED'
                  ? 'MIC BLOCKED (TAP SYNC)'
                  : 'CAPTURING...'}
              </span>
            </div>
          </div>

          <div className="border border-neutral-900 bg-black p-3 rounded space-y-1">
            <div className="text-[10px] text-neutral-500">BATTERY TELEMETRY</div>
            <div className="flex items-center gap-1.5 font-semibold text-neutral-300">
              <BatteryCharging className="w-3.5 h-3.5 text-cyan-500" />
              <span>
                {batteryInfo.level !== null ? `${batteryInfo.level}%` : 'READING...'}
              </span>
            </div>
          </div>
        </div>

        <div className="border border-neutral-900 bg-black p-3 rounded space-y-2">
          <div className="flex items-center justify-between text-[11px] text-neutral-500">
            <span className="flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-cyan-500" />
              <span>VOCAL ISOLATION (300–3400Hz) MODULATION</span>
            </span>
            <span className="text-cyan-400">{audioRms}%</span>
          </div>
          <div className="w-full h-1.5 bg-neutral-950 rounded overflow-hidden">
            <div
              className="h-full bg-cyan-500 transition-all duration-75"
              style={{ width: `${Math.min(100, audioRms)}%` }}
            />
          </div>
        </div>

        <div className="border border-neutral-900 bg-black p-3 rounded space-y-1.5 text-[11px]">
          <div className="flex items-center justify-between text-neutral-500">
            <span className="flex items-center gap-1.5">
              <Navigation className="w-3.5 h-3.5 text-cyan-500" />
              <span>GPS TELEMETRY PAYLOAD</span>
            </span>
          </div>
          {gpsState.lat !== null && gpsState.lng !== null ? (
            <div className="grid grid-cols-2 gap-2 pt-1 text-neutral-300">
              <div>LAT: {gpsState.lat.toFixed(6)}°</div>
              <div>LNG: {gpsState.lng.toFixed(6)}°</div>
              <div>ALT: {gpsState.alt !== null ? `${gpsState.alt}m` : 'N/A'}</div>
              <div>
                PREC: {gpsState.accuracy !== null ? `±${gpsState.accuracy}m` : 'N/A'}
              </div>
            </div>
          ) : (
            <div className="pt-1 text-neutral-500 text-[11px]">
              Mengunci koordinat satelit GPS perangkat...
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-neutral-900 pt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-500">
        <div className="flex items-center gap-1.5">
          <ShieldAlert className="w-3.5 h-3.5 text-cyan-500/70" />
          <span>STANDBY-SAFE MUTE · VOCAL ISOLATION 300–3400Hz · GAIN 3.0x</span>
        </div>
        <span>TARGET: {targetMasterId}</span>
      </div>
    </div>
  );
};

export default Client;
