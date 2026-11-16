import React, { useEffect, useRef, useState, useCallback } from 'react';
import Peer, { DataConnection, MediaConnection } from 'peerjs';
import { MapContainer, TileLayer, Marker, Polyline, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import {
  Radio,
  Disc,
  Volume2,
  VolumeX,
  FolderDown,
  Download,
  Trash2,
  Play,
  Pause,
  Battery,
  Signal,
  Crosshair,
  ArrowLeft,
  X,
  Wifi,
  QrCode,
  Smartphone,
  ScanLine,
  PhoneOff,
  Mic,
  MicOff,
  Skull,
} from 'lucide-react';
import { PWAInstallButton } from './PWAInstallButton';
import { BarcodeModal } from './BarcodeModal';
import type { TelemetryPayload } from './Client';
import { sendCommand, triggerEmergencyWipe } from './tacticalRemoteControl';
import {
  setupNegotiation,
  handleIncomingAudio,
  unlockAudioAutoplay,
  removeInjectedAudioElement,
  type SignalingEnvelope,
} from './webrtcAudioEngine';

export interface ClientStreamEntry {
  id: string;
  stream: MediaStream;
}

const ClientAudioElement: React.FC<{
  id: string;
  stream: MediaStream;
  muted: boolean;
  onRegisterEl: (id: string, el: HTMLAudioElement | null) => void;
  onAutoplayBlocked: () => void;
  onAutoplaySuccess: () => void;
}> = ({
  id,
  stream,
  muted,
  onRegisterEl,
  onAutoplayBlocked,
  onAutoplaySuccess,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = audioRef.current;
    onRegisterEl(id, el);
    if (!el) return;

    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    el.muted = muted;
    // Gunakan volume 0 pada elemen <audio> mentah agar decoder WebRTC Chrome/Android tetap aktif
    // sementara 100% output suara yang terdengar berasal dari Telephony-Grade DSP Pipeline (AudioContext.destination)
    el.volume = 0;

    const p = el.play();
    if (p !== undefined) {
      p.then(() => onAutoplaySuccess()).catch((err: unknown) => {
        const name = err instanceof Error ? err.name : String(err);
        if (name === 'NotAllowedError') {
          onAutoplayBlocked();
        }
      });
    }

    return () => {
      onRegisterEl(id, null);
    };
  }, [id, stream, muted, onRegisterEl, onAutoplayBlocked, onAutoplaySuccess]);

  return (
    <audio
      ref={audioRef}
      id={`audio-${id}`}
      autoPlay
      playsInline
      muted={muted}
    />
  );
};

export type AutoRecordMode = 'OFF' | 'IMMEDIATE' | 'VOX';

export interface ConnectedClient {
  nodeId: string; // 4-digit ID e.g. "7734"
  peerId: string; // "sigma-node-XXXX"
  label: string; // "NODE_01" .. "NODE_05"
  connectionStatus: 'connected';
  hasAudioStream: boolean;
  lat: number | null;
  lng: number | null;
  alt: number | null;
  accuracy: number | null;
  speed: number | null;
  battery: number | null;
  gainDb: number; // 0, 6, 12, 18, 24
  remoteMuted: boolean;
  volumeLevel: number; // 0..100 live WebRTC RMS
  peakLevel: number; // 0..100
  isRecording: boolean;
  recordingTrigger: 'MANUAL' | 'IMMEDIATE' | 'VOX' | null;
  recordingStartedAt: number | null;
  voxSilenceMs: number; // 0..10000ms
  lastTelemetryAt: number;
}

export interface RecordedClip {
  id: string;
  filename: string;
  nodeLabel: string;
  nodeId: string;
  trigger: 'MANUAL' | 'IMMEDIATE' | 'VOX';
  createdAt: Date;
  durationSec: number;
  sizeBytes: number;
  url: string;
  mimeType: string;
}

interface MasterProps {
  onExit: () => void;
}

const INDONESIA_DEFAULT_CENTER: [number, number] = [-2.5489, 118.0149];
const GAIN_STEPS = [0, 6, 12, 18, 24];
const MAX_CLIENTS = 5;

const RTC_CONFIG: RTCConfiguration = {
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

function getSignalingWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function formatFileTimestamp(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

function createTacticalMarkerIcon(client: ConnectedClient): L.DivIcon {
  const recBadge = client.isRecording
    ? `<span style="color:#ff3b3b;font-weight:700;margin-left:4px;">●REC</span>`
    : '';

  return L.divIcon({
    className: 'sigma-node-marker-icon',
    iconSize: [215, 68],
    iconAnchor: [14, 33],
    html: `
      <div style="display:flex;align-items:flex-start;gap:6px;font-family:'JetBrains Mono',monospace;pointer-events:auto;">
        <div style="position:relative;width:26px;height:26px;display:flex;align-items:center;justify-content:center;margin-top:4px;">
          <span style="position:absolute;inset:0;border-radius:9999px;background:rgba(0,255,255,0.28);animation:ping 1.8s cubic-bezier(0,0,0.2,1) infinite;"></span>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M12 2C7.58 2 4 5.58 4 10C4 16.08 12 22 12 22C12 22 20 16.08 20 10C20 5.58 16.42 2 12 2Z" fill="#00FFFF" fill-opacity="0.9" stroke="#020617" stroke-width="1.5"/>
            <circle cx="12" cy="10" r="3.5" fill="#020617"/>
          </svg>
        </div>
        <div style="background:rgba(3,10,20,0.9);border:1px solid rgba(0,255,255,0.6);border-radius:3px;padding:4px 7px;color:#e0f2fe;font-size:10px;line-height:1.28;box-shadow:0 4px 14px rgba(0,0,0,0.75);backdrop-filter:blur(4px);min-width:155px;">
          <div style="font-weight:700;color:#00FFFF;font-size:11px;letter-spacing:0.04em;">
            ${client.label} <span style="font-weight:400;opacity:0.85;">(${
      client.nodeId
    })</span>${recBadge}
          </div>
          <div style="color:#cbd5e1;">LAT: ${client.lat?.toFixed(6)}°</div>
          <div style="color:#cbd5e1;">LNG: ${client.lng?.toFixed(6)}°</div>
          <div style="color:#67e8f9;font-size:9.5px;">
            ALT: ${client.alt !== null ? `${client.alt}m` : 'N/A'} · PREC: ${
      client.accuracy !== null ? `±${client.accuracy}m` : 'N/A'
    }
          </div>
        </div>
      </div>
    `,
  });
}

const MapViewportController: React.FC<{
  center: [number, number];
  zoom: number;
}> = ({ center, zoom }) => {
  const map = useMap();
  const prevCenterRef = useRef<string>('');

  useEffect(() => {
    const key = `${center[0].toFixed(4)},${center[1].toFixed(4)},${zoom}`;
    if (prevCenterRef.current !== key) {
      prevCenterRef.current = key;
      map.setView(center, zoom, { animate: true });
    }
  }, [center, zoom, map]);

  return (
    <button
      type="button"
      onClick={() => map.setView(center, zoom, { animate: true })}
      className="absolute bottom-8 right-3 z-[500] flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono-tactical bg-[#040d1a]/90 border border-cyan-500/50 text-cyan-300 rounded hover:bg-cyan-500/20 transition-colors cursor-pointer"
      title="Recenter Tactical Map"
    >
      <Crosshair className="w-3 h-3 text-cyan-400" />
      <span>RECENTER HUD</span>
    </button>
  );
};

interface AudioPipelineEntry {
  stream: MediaStream;
  processedStream: MediaStream;
  sourceNode: MediaStreamAudioSourceNode;
  highpassFilter: BiquadFilterNode;
  lowpassFilter: BiquadFilterNode;
  compressorNode: DynamicsCompressorNode;
  gainNode: GainNode;
  analyser: AnalyserNode;
  speakerGain: GainNode;
  recorder: MediaRecorder | null;
  chunks: BlobPart[];
  startedAt: number;
  trigger: 'MANUAL' | 'IMMEDIATE' | 'VOX';
}

export const Master: React.FC<MasterProps> = ({ onExit }) => {
  // 1. STRICT EMPTY INITIALIZATION: NO MOCK DATA
  const [clients, setClients] = useState<ConnectedClient[]>([]);

  const [masterCoords, setMasterCoords] = useState<{
    lat: number;
    lng: number;
    hasLock: boolean;
  }>({
    lat: INDONESIA_DEFAULT_CENTER[0],
    lng: INDONESIA_DEFAULT_CENTER[1],
    hasLock: false,
  });

  const [clockStr, setClockStr] = useState<string>('00:00:00:00');
  const [autoRecordMode, setAutoRecordMode] = useState<AutoRecordMode>('IMMEDIATE');
  const [voxThreshold, setVoxThreshold] = useState<number>(28);
  const [soloNodeId, setSoloNodeId] = useState<string | null>(null);
  const [masterMuted, setMasterMuted] = useState<boolean>(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState<boolean>(false);
  const [recordings, setRecordings] = useState<RecordedClip[]>([]);
  const [showRecordingsDrawer, setShowRecordingsDrawer] = useState<boolean>(false);
  const [autoDownloadClips, setAutoDownloadClips] = useState<boolean>(false);
  const [playingClipId, setPlayingClipId] = useState<string | null>(null);
  const [dialInput, setDialInput] = useState<string>('');
  const [connectionBanner, setConnectionBanner] = useState<string>(
    'STANDBY · MENUNGGU KONEKSI P2P CLIENT...'
  );
  const [masterPeerId, setMasterPeerId] = useState<string>('');
  const [barcodeModalOpen, setBarcodeModalOpen] = useState<boolean>(false);
  const [barcodeModalTab, setBarcodeModalTab] = useState<
    'CLIENT_JOIN' | 'SHARE_APK' | 'SCANNER'
  >('CLIENT_JOIN');
  const [barcodeTargetNodeId, setBarcodeTargetNodeId] = useState<string>('');

  // 2. PENGGUNAAN USEREF & CLIENTSTREAMS DI MASTER (REACT):
  // WAJIB gunakan `const peerConnections = useRef(new Map())` agar koneksi Client 1
  // tidak terhapus dari memori saat komponen me-render ulang untuk menerima Client 2..5.
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const nativeDataChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const remoteDescReadyRef = useRef<Map<string, boolean>>(new Map());
  const [clientStreams, setClientStreams] = useState<ClientStreamEntry[]>([]);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const pipelinesRef = useRef<Map<string, AudioPipelineEntry>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);

  const dataConnsRef = useRef<Map<string, DataConnection>>(new Map());
  const mediaCallsRef = useRef<Map<string, MediaConnection>>(new Map());
  const negotiationHandlersRef = useRef<
    Map<string, ReturnType<typeof setupNegotiation>>
  >(new Map());
  const canvasesRef = useRef<Map<string, HTMLCanvasElement | null>>(new Map());
  // Dedicated HTML <audio autoPlay playsInline> elements per connected Client Node
  const nodeAudioElsRef = useRef<Map<string, HTMLAudioElement | null>>(new Map());
  const peerRef = useRef<Peer | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

  const clientsRef = useRef(clients);
  clientsRef.current = clients;

  const autoRecordModeRef = useRef(autoRecordMode);
  autoRecordModeRef.current = autoRecordMode;

  const voxThresholdRef = useRef(voxThreshold);
  voxThresholdRef.current = voxThreshold;

  const soloNodeIdRef = useRef(soloNodeId);
  soloNodeIdRef.current = soloNodeId;

  const masterMutedRef = useRef(masterMuted);
  masterMutedRef.current = masterMuted;

  const autoDownloadRef = useRef(autoDownloadClips);
  autoDownloadRef.current = autoDownloadClips;

  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMasterCoords({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          hasLock: true,
        });
      },
      () => {},
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }, []);

  useEffect(() => {
    let raf: number;
    const tick = () => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      const ms = String(Math.floor(now.getMilliseconds() / 10)).padStart(2, '0');
      setClockStr(`${hh}:${mm}:${ss}:${ms}`);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  }, []);

  /**
   * Buat stream audio senyap (silent audio track) saat Master melakukan panggilan `peer.call`
   * agar SDP Offer dari Master SELALU memiliki bagian `m=audio` (sendrecv)
   * sehingga track audio dari Client tidak ditolak oleh negosiasi WebRTC.
   */
  const createMasterOfferDummyStream = useCallback((): MediaStream => {
    const ctx = getAudioContext();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0; // 100% senyap
    osc.connect(silentGain);
    silentGain.connect(dest);
    osc.start();
    return dest.stream;
  }, [getAudioContext]);

  /**
   * Fungsi untuk membuka blokir Autoplay Policy pada semua elemen <audio autoPlay playsInline>
   * dan meresume AudioContext ketika user mengklik di mana saja pada halaman Master.
   */
  const unlockAllAudioPlayback = useCallback(() => {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    // Panggil modul Autoplay Unlocker untuk semua elemen <audio> yang diinjeksikan
    unlockAudioAutoplay(undefined, {
      audioContext: ctx,
      onUnlocked: () => setAutoplayBlocked(false),
      onBlocked: () => setAutoplayBlocked(true),
    });

    let anyBlocked = false;
    nodeAudioElsRef.current.forEach((audioEl, nodeId) => {
      if (!audioEl) return;
      const entry = pipelinesRef.current.get(nodeId);
      if (entry && audioEl.srcObject !== entry.stream) {
        audioEl.srcObject = entry.stream;
      }
      const shouldPlay =
        !masterMutedRef.current &&
        (soloNodeIdRef.current === null || soloNodeIdRef.current === nodeId);
      audioEl.muted = !shouldPlay;
      audioEl.volume = 1.0;

      const playPromise = audioEl.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            setAutoplayBlocked(false);
          })
          .catch(() => {
            anyBlocked = true;
          });
      }
    });

    if (!anyBlocked) {
      setAutoplayBlocked(false);
    }
  }, [getAudioContext]);

  // Global listener untuk mengatasi Browser Autoplay Policy otomatis saat operator menyentuh layar
  useEffect(() => {
    const handleUserGesture = () => {
      unlockAllAudioPlayback();
    };
    window.addEventListener('pointerdown', handleUserGesture, { passive: true });
    window.addEventListener('keydown', handleUserGesture, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', handleUserGesture);
      window.removeEventListener('keydown', handleUserGesture);
    };
  }, [unlockAllAudioPlayback]);

  const startNodeRecording = useCallback(
    (nodeId: string, trigger: 'MANUAL' | 'IMMEDIATE' | 'VOX') => {
      const entry = pipelinesRef.current.get(nodeId);
      if (!entry || entry.recorder?.state === 'recording') return;

      const targetStream =
        entry.processedStream.getAudioTracks().length > 0
          ? entry.processedStream
          : entry.stream;

      let mimeType = 'audio/webm;codecs=opus';
      if (typeof MediaRecorder !== 'undefined') {
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
        }
      } else {
        return;
      }

      try {
        const recorder = mimeType
          ? new MediaRecorder(targetStream, { mimeType })
          : new MediaRecorder(targetStream);

        entry.chunks = [];
        entry.startedAt = Date.now();
        entry.trigger = trigger;
        entry.recorder = recorder;

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            entry.chunks.push(e.data);
          }
        };

        recorder.onstop = () => {
          const stoppedAt = new Date();
          const durationSec = Math.max(
            1,
            Math.round((stoppedAt.getTime() - entry.startedAt) / 1000)
          );
          const blob = new Blob(entry.chunks, { type: mimeType || 'audio/webm' });
          const url = URL.createObjectURL(blob);
          const clientObj = clientsRef.current.find((c) => c.nodeId === nodeId);
          const filename = `SIGMA_REC_${nodeId}_${formatFileTimestamp(stoppedAt)}.webm`;

          const clip: RecordedClip = {
            id: `${nodeId}-${stoppedAt.getTime()}`,
            filename,
            nodeLabel: clientObj?.label || `NODE_${nodeId}`,
            nodeId,
            trigger: entry.trigger,
            createdAt: stoppedAt,
            durationSec,
            sizeBytes: blob.size,
            url,
            mimeType: mimeType || 'audio/webm',
          };

          setRecordings((prev) => [clip, ...prev]);

          if (autoDownloadRef.current) {
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }
        };

        recorder.start(250);

        setClients((prev) =>
          prev.map((c) =>
            c.nodeId === nodeId
              ? {
                  ...c,
                  isRecording: true,
                  recordingTrigger: trigger,
                  recordingStartedAt: Date.now(),
                  voxSilenceMs: 0,
                }
              : c
          )
        );
      } catch {}
    },
    []
  );

  const stopNodeRecording = useCallback((nodeId: string) => {
    const entry = pipelinesRef.current.get(nodeId);
    if (entry && entry.recorder && entry.recorder.state === 'recording') {
      try {
        entry.recorder.stop();
      } catch {}
      entry.recorder = null;
    }
    setClients((prev) =>
      prev.map((c) =>
        c.nodeId === nodeId
          ? {
              ...c,
              isRecording: false,
              recordingTrigger: null,
              recordingStartedAt: null,
              voxSilenceMs: 0,
            }
          : c
      )
    );
  }, []);

  const upsertConnectedClient = useCallback(
    (
      nodeId: string,
      updates: Partial<
        Pick<
          ConnectedClient,
          | 'hasAudioStream'
          | 'lat'
          | 'lng'
          | 'alt'
          | 'accuracy'
          | 'speed'
          | 'battery'
          | 'remoteMuted'
          | 'lastTelemetryAt'
        >
      >
    ) => {
      setClients((prev) => {
        const existingIdx = prev.findIndex((c) => c.nodeId === nodeId);
        if (existingIdx !== -1) {
          return prev.map((c, i) =>
            i === existingIdx
              ? {
                  ...c,
                  ...updates,
                  connectionStatus: 'connected',
                }
              : c
          );
        }

        if (prev.length >= 5) return prev;

        const nextSlotNumber = prev.length + 1;
        const newClient: ConnectedClient = {
          nodeId,
          peerId: `sigma-node-${nodeId}`,
          label: `NODE_0${nextSlotNumber}`,
          connectionStatus: 'connected',
          hasAudioStream: updates.hasAudioStream ?? false,
          lat: updates.lat ?? null,
          lng: updates.lng ?? null,
          alt: updates.alt ?? null,
          accuracy: updates.accuracy ?? null,
          speed: updates.speed ?? null,
          battery: updates.battery ?? null,
          gainDb: 0,
          remoteMuted: updates.remoteMuted ?? false,
          volumeLevel: 0,
          peakLevel: 0,
          isRecording: false,
          recordingTrigger: null,
          recordingStartedAt: null,
          voxSilenceMs: 0,
          lastTelemetryAt: updates.lastTelemetryAt ?? Date.now(),
        };

        return [...prev, newClient];
      });
    },
    []
  );

  const removeDisconnectedClient = useCallback((nodeId: string) => {
    const hasOpenData = dataConnsRef.current.get(nodeId)?.open;
    const hasOpenMedia = mediaCallsRef.current.get(nodeId)?.open;
    const nativePc = peerConnections.current.get(nodeId);
    const hasOpenNativePc =
      nativePc &&
      (nativePc.connectionState === 'connected' ||
        nativePc.iceConnectionState === 'connected' ||
        nativePc.iceConnectionState === 'completed');

    if (hasOpenData || hasOpenMedia || hasOpenNativePc) return;

    const existingPc = peerConnections.current.get(nodeId);
    if (existingPc) {
      try {
        existingPc.ontrack = null;
        existingPc.onicecandidate = null;
        existingPc.ondatachannel = null;
        existingPc.oniceconnectionstatechange = null;
        existingPc.onconnectionstatechange = null;
        existingPc.close();
      } catch {}
      peerConnections.current.delete(nodeId);
    }
    nativeDataChannelsRef.current.delete(nodeId);
    pendingCandidatesRef.current.delete(nodeId);

    setClientStreams((prev) => prev.filter((item) => item.id !== nodeId));

    const audioEl = nodeAudioElsRef.current.get(nodeId);
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      nodeAudioElsRef.current.delete(nodeId);
    }
    removeInjectedAudioElement(nodeId);
    negotiationHandlersRef.current.get(nodeId)?.cleanup();
    negotiationHandlersRef.current.delete(nodeId);

    const entry = pipelinesRef.current.get(nodeId);
    if (entry) {
      if (entry.recorder && entry.recorder.state === 'recording') {
        try {
          entry.recorder.stop();
        } catch {}
      }
      try {
        entry.sourceNode.disconnect();
        entry.highpassFilter.disconnect();
        entry.lowpassFilter.disconnect();
        entry.compressorNode.disconnect();
        entry.gainNode.disconnect();
        entry.analyser.disconnect();
        entry.speakerGain.disconnect();
      } catch {}
      pipelinesRef.current.delete(nodeId);
    }

    setClients((prev) =>
      prev
        .filter((c) => c.nodeId !== nodeId)
        .map((c, idx) => ({
          ...c,
          label: `NODE_0${idx + 1}`,
        }))
    );
  }, []);

  /**
   * PERBAIKAN PENTING 2 & 3:
   * Sambungkan MediaStream dari Client ke:
   * 1. Elemen HTML `<audio autoPlay playsInline>` menggunakan `audioEl.srcObject = remoteStream`
   * 2. Web Audio API `AudioContext` (GainNode + AnalyserNode) untuk visualizer & gain boost
   */
  const attachWebRTCStreamToNode = useCallback(
    (nodeId: string, remoteStream: MediaStream) => {
      if (!remoteStream || remoteStream.getAudioTracks().length === 0) return;

      // Pastikan semua audio track yang diterima aktif
      remoteStream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });

      const ctx = getAudioContext();

      const existing = pipelinesRef.current.get(nodeId);
      const existingTrackSig = existing
        ? existing.stream
            .getAudioTracks()
            .map((t) => t.id)
            .join(',')
        : '';
      const incomingTrackSig = remoteStream
        .getAudioTracks()
        .map((t) => t.id)
        .join(',');

      if (
        existing &&
        existing.stream.id === remoteStream.id &&
        existingTrackSig === incomingTrackSig
      ) {
        // Stream dan daftar track yang sama sudah terpasang; cukup pastikan <audio> diputar
        unlockAllAudioPlayback();
        return;
      }

      if (existing) {
        if (existing.recorder && existing.recorder.state === 'recording') {
          try {
            existing.recorder.stop();
          } catch {}
        }
        try {
          existing.sourceNode.disconnect();
          existing.highpassFilter.disconnect();
          existing.lowpassFilter.disconnect();
          existing.compressorNode.disconnect();
          existing.gainNode.disconnect();
          existing.analyser.disconnect();
          existing.speakerGain.disconnect();
        } catch {}
      }

      // ============================================================================
      // TELEPHONY-GRADE DSP PIPELINE (MASTER AUDIO RECEIVER)
      // Urutan Pipa Audio (Tanpa Noise Gate agar suara lingkungan tetap mengalir):
      // 1. MediaStreamSource (event.streams[0])
      // 2. Highpass Filter (150 Hz) -> Buang gemuruh angin/mesin
      // 3. Lowpass Filter (4000 Hz) -> Buang desis frekuensi tinggi (fokus vokal telepon)
      // 4. DynamicsCompressorNode (threshold: -35, knee: 10, ratio: 8, attack: 0.01, release: 0.25)
      // 5. GainNode Eksisting (terhubung ke Slider UI Master) -> AudioContext.destination
      // ============================================================================

      // 1. TANGKAP STREAM: Ambil event.streams[0] (remoteStream)
      const sourceNode = ctx.createMediaStreamSource(remoteStream);

      // 2. HIGHPASS FILTER (Buang gemuruh angin/mesin di bawah 150 Hz)
      const highpassFilter = ctx.createBiquadFilter();
      highpassFilter.type = 'highpass';
      highpassFilter.frequency.value = 150;

      // 3. LOWPASS FILTER (Buang desis statis frekuensi tinggi di atas 4000 Hz)
      const lowpassFilter = ctx.createBiquadFilter();
      lowpassFilter.type = 'lowpass';
      lowpassFilter.frequency.value = 4000;

      // 4. DYNAMICS COMPRESSOR (Perata Suara agar bisikan/suara jauh terangkat jernih)
      const compressorNode = ctx.createDynamicsCompressor();
      compressorNode.threshold.value = -35;
      compressorNode.knee.value = 10;
      compressorNode.ratio.value = 8;
      compressorNode.attack.value = 0.01;
      compressorNode.release.value = 0.25;

      // 5. HUBUNGKAN KE GAIN NODE EKSISTING (Terintegrasi dengan Slider UI Master)
      const gainNode = ctx.createGain();
      const clientConfig = clientsRef.current.find((c) => c.nodeId === nodeId);
      const db = clientConfig ? clientConfig.gainDb : 0;
      gainNode.gain.value = Math.pow(10, db / 20);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;

      const destNode = ctx.createMediaStreamDestination();
      const speakerGain = ctx.createGain();

      const isSoloAllowed =
        !masterMutedRef.current &&
        (soloNodeIdRef.current === null || soloNodeIdRef.current === nodeId);
      speakerGain.gain.value = isSoloAllowed ? 1.0 : 0.0;

      // Rangkai Pipa Audio secara berurutan:
      // Stream -> Highpass (150Hz) -> Lowpass (4000Hz) -> Compressor -> GainNode -> Destination
      sourceNode.connect(highpassFilter);
      highpassFilter.connect(lowpassFilter);
      lowpassFilter.connect(compressorNode);
      compressorNode.connect(gainNode);

      // Keluaran dari GainNode menuju Analyser (Visualizer), MediaRecorder (.webm), dan Speaker Master
      gainNode.connect(analyser);
      gainNode.connect(destNode);
      gainNode.connect(speakerGain);
      speakerGain.connect(ctx.destination);

      const entry: AudioPipelineEntry = {
        stream: remoteStream,
        processedStream: destNode.stream,
        sourceNode,
        highpassFilter,
        lowpassFilter,
        compressorNode,
        gainNode,
        analyser,
        speakerGain,
        recorder: null,
        chunks: [],
        startedAt: Date.now(),
        trigger: 'IMMEDIATE',
      };

      pipelinesRef.current.set(nodeId, entry);

      upsertConnectedClient(nodeId, {
        hasAudioStream: true,
        lastTelemetryAt: Date.now(),
      });

      // Tambahkan/perbarui `{ id: senderId, stream }` ke state `clientStreams`
      // untuk dipetakan (map) di JSX menjadi beberapa elemen `<audio autoPlay playsInline>` terpisah
      setClientStreams((prev) => {
        const exists = prev.some((item) => item.id === nodeId);
        if (exists) {
          return prev.map((item) =>
            item.id === nodeId ? { id: nodeId, stream: remoteStream } : item
          );
        }
        return [...prev, { id: nodeId, stream: remoteStream }];
      });

      if (autoRecordModeRef.current === 'IMMEDIATE') {
        setTimeout(() => {
          startNodeRecording(nodeId, 'IMMEDIATE');
        }, 150);
      }
    },
    [
      getAudioContext,
      startNodeRecording,
      unlockAllAudioPlayback,
      upsertConnectedClient,
    ]
  );

  const handleIncomingTelemetry = useCallback(
    (payload: TelemetryPayload) => {
      if (!payload || payload.type !== 'SIGMA_TELEMETRY' || !payload.nodeId) return;

      upsertConnectedClient(payload.nodeId, {
        lat: typeof payload.lat === 'number' ? payload.lat : undefined,
        lng: typeof payload.lng === 'number' ? payload.lng : undefined,
        alt: payload.alt,
        accuracy: payload.accuracy,
        speed: payload.speed,
        battery: payload.battery,
        remoteMuted:
          typeof payload.remoteMuted === 'boolean' ? payload.remoteMuted : undefined,
        lastTelemetryAt: payload.timestamp || Date.now(),
      });
    },
    [upsertConnectedClient]
  );

  const registerDataConnection = useCallback(
    (rawNodeId: string, conn: DataConnection) => {
      const nodeId = rawNodeId.replace('sigma-node-', '').trim();
      dataConnsRef.current.set(nodeId, conn);

      const bindDataPcHandlers = () => {
        if (!conn.peerConnection) return;

        const negHandler = setupNegotiation(conn.peerConnection, {
          dataChannel: conn,
          nodeId,
        });
        negotiationHandlersRef.current.set(nodeId, negHandler);

        const pcWithFlag = conn.peerConnection as RTCPeerConnection & {
          __sigmaTrackBound?: boolean;
        };
        if (!pcWithFlag.__sigmaTrackBound) {
          pcWithFlag.__sigmaTrackBound = true;
          conn.peerConnection.addEventListener('track', (event: RTCTrackEvent) => {
            handleIncomingAudio(event, {
              audioId: nodeId,
              onStreamAttached: (inboundStream) => {
                attachWebRTCStreamToNode(nodeId, inboundStream);
                setConnectionBanner(
                  `LIVE WEBRTC AUDIO TRACK ACTIVE (RENEGOTIATED): NODE (${nodeId})`
                );
              },
              onAutoplaySuccess: () => setAutoplayBlocked(false),
              onAutoplayBlocked: () => setAutoplayBlocked(true),
            });
          });
        }
      };

      bindDataPcHandlers();

      conn.on('open', () => {
        bindDataPcHandlers();
        upsertConnectedClient(nodeId, { lastTelemetryAt: Date.now() });
        setConnectionBanner(`RTCPeerConnection CONNECTED: NODE (${nodeId})`);

        if (peerRef.current?.id) {
          try {
            conn.send({
              type: 'SIGMA_REQUEST_AUDIO_STREAM',
              masterPeerId: peerRef.current.id,
            });
          } catch {}
        }
      });

      conn.on('data', (data) => {
        let parsed: Record<string, unknown> | null = null;
        if (typeof data === 'string') {
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {}
        } else if (data && typeof data === 'object') {
          parsed = data as Record<string, unknown>;
        }

        if (
          parsed &&
          (parsed.type === 'SIGMA_SDP_RENEGOTIATE_OFFER' ||
            parsed.type === 'SIGMA_SDP_RENEGOTIATE_ANSWER' ||
            parsed.type === 'SIGMA_ICE_CANDIDATE')
        ) {
          bindDataPcHandlers();
          negotiationHandlersRef.current
            .get(nodeId)
            ?.handleRemoteSignal(parsed as unknown as SignalingEnvelope)
            .catch(() => {});
          return;
        }

        handleIncomingTelemetry(data as TelemetryPayload);
      });

      conn.on('close', () => {
        dataConnsRef.current.delete(nodeId);
        removeDisconnectedClient(nodeId);
      });

      conn.on('error', () => {
        dataConnsRef.current.delete(nodeId);
        removeDisconnectedClient(nodeId);
      });
    },
    [
      attachWebRTCStreamToNode,
      handleIncomingTelemetry,
      removeDisconnectedClient,
      upsertConnectedClient,
    ]
  );

  /**
   * PERBAIKAN PENTING 2:
   * Gunakan `pc.addEventListener('track', ...)` (BUKAN menimpa `pc.ontrack = ...`)
   * agar handler internal PeerJS `call.on('stream')` tetap berjalan dan suara dari Samsung A26 selalu muncul!
   */
  const registerMediaConnection = useCallback(
    (rawNodeId: string, call: MediaConnection) => {
      const nodeId = rawNodeId.replace('sigma-node-', '').trim();
      mediaCallsRef.current.set(nodeId, call);
      upsertConnectedClient(nodeId, { lastTelemetryAt: Date.now() });

      const bindOnTrack = (pc?: RTCPeerConnection) => {
        if (!pc) return;
        const pcWithFlag = pc as RTCPeerConnection & {
          __sigmaMediaTrackBound?: boolean;
        };
        if (pcWithFlag.__sigmaMediaTrackBound) return;
        pcWithFlag.__sigmaMediaTrackBound = true;

        setupNegotiation(pc, {
          dataChannel: dataConnsRef.current.get(nodeId) || null,
          nodeId,
        });

        pc.addEventListener('track', (event: RTCTrackEvent) => {
          handleIncomingAudio(event, {
            audioId: nodeId,
            onStreamAttached: (inboundStream) => {
              attachWebRTCStreamToNode(nodeId, inboundStream);
              setConnectionBanner(`LIVE WEBRTC AUDIO TRACK ACTIVE: NODE (${nodeId})`);
            },
            onAutoplaySuccess: () => setAutoplayBlocked(false),
            onAutoplayBlocked: () => setAutoplayBlocked(true),
          });
        });
      };

      bindOnTrack(call.peerConnection);

      call.on('stream', (remoteStream) => {
        bindOnTrack(call.peerConnection);
        handleIncomingAudio(
          { streams: [remoteStream] },
          {
            audioId: nodeId,
            onStreamAttached: (inboundStream) => {
              attachWebRTCStreamToNode(nodeId, inboundStream);
              setConnectionBanner(`LIVE WEBRTC AUDIO STREAM ACTIVE: NODE (${nodeId})`);
            },
            onAutoplaySuccess: () => setAutoplayBlocked(false),
            onAutoplayBlocked: () => setAutoplayBlocked(true),
          }
        );
      });

      call.on('close', () => {
        mediaCallsRef.current.delete(nodeId);
        removeDisconnectedClient(nodeId);
      });

      call.on('error', () => {
        mediaCallsRef.current.delete(nodeId);
        removeDisconnectedClient(nodeId);
      });
    },
    [attachWebRTCStreamToNode, removeDisconnectedClient, upsertConnectedClient]
  );

  const connectToRemoteNode = useCallback(
    (rawFourDigitId: string) => {
      const cleaned = rawFourDigitId.replace('sigma-node-', '').trim();
      if (!cleaned) return;

      unlockAllAudioPlayback();

      const peer = peerRef.current;
      if (!peer || !peer.open) {
        setConnectionBanner('SIGNALING SERVER BELUM SIAP, COBA SESAAT LAGI...');
        return;
      }

      const targetPeerId = `sigma-node-${cleaned}`;
      setConnectionBanner(`MENGHUBUNGKAN KE NODE ${cleaned} (${targetPeerId})...`);

      // 1. Open WebRTC DataChannel to Node
      const conn: DataConnection = peer.connect(targetPeerId, {
        reliable: true,
      });
      registerDataConnection(cleaned, conn);

      // 2. Place WebRTC Media Call to Node dengan dummy audio track nyata agar SDP memiliki m=audio
      const offerStream = createMasterOfferDummyStream();
      const call: MediaConnection = peer.call(targetPeerId, offerStream);
      if (call) {
        registerMediaConnection(cleaned, call);
      }
    },
    [
      createMasterOfferDummyStream,
      registerDataConnection,
      registerMediaConnection,
      unlockAllAudioPlayback,
    ]
  );

  const disconnectNode = useCallback(
    (nodeId: string) => {
      stopNodeRecording(nodeId);
      const pc = peerConnections.current.get(nodeId);
      if (pc) {
        try {
          pc.close();
        } catch {}
        peerConnections.current.delete(nodeId);
      }
      const dc = nativeDataChannelsRef.current.get(nodeId);
      if (dc) {
        try {
          dc.close();
        } catch {}
        nativeDataChannelsRef.current.delete(nodeId);
      }
      const conn = dataConnsRef.current.get(nodeId);
      if (conn) {
        conn.close();
        dataConnsRef.current.delete(nodeId);
      }
      const call = mediaCallsRef.current.get(nodeId);
      if (call) {
        call.close();
        mediaCallsRef.current.delete(nodeId);
      }
      removeDisconnectedClient(nodeId);
    },
    [removeDisconnectedClient, stopNodeRecording]
  );

  // Simpan fungsi handler di dalam ref agar useEffect WebSocket cukup dieksekusi 1x (`[]`)
  // dan TIDAK PERNAH me-reset koneksi saat re-render state!
  const handlersRef = useRef({
    attachWebRTCStreamToNode,
    handleIncomingTelemetry,
    removeDisconnectedClient,
    upsertConnectedClient,
  });
  handlersRef.current = {
    attachWebRTCStreamToNode,
    handleIncomingTelemetry,
    removeDisconnectedClient,
    upsertConnectedClient,
  };

  /**
   * ============================================================================
   * PENERIMAAN OTOMATIS MULTI-PEER (1 MASTER -> 5 KLIEN) DENGAN `useRef(new Map())`
   * ============================================================================
   * 1. Saat Master dimuat, mendaftar ke WebSocket dengan ID `"MASTER"`.
   * 2. Menyimpan setiap RTCPeerConnection di `peerConnections.current.set(senderId, pc)`
   *    (`useRef(new Map())`) sehingga re-render saat Klien ke-2 masuk tidak pernah
   *    menghapus koneksi Klien ke-1.
   * 3. Semua jawaban (`answer`) dan `candidate` dikirim dengan `targetId: senderId`.
   */
  useEffect(() => {
    let isMounted = true;
    let reconnectTimer: number | null = null;
    let wsFailCount = 0;
    const pcMap = peerConnections.current;
    const dcMap = nativeDataChannelsRef.current;
    const candQueueMap = pendingCandidatesRef.current;

    const connectMasterWebSocket = () => {
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

        ws.onopen = () => {
          if (!isMounted) return;
          wsFailCount = 0;
          const regPayload = {
            type: 'register',
            id: 'MASTER',
          };
          ws.send(JSON.stringify(regPayload));
          setConnectionBanner(
            'MASTER ONLINE (ID: MASTER) · SIAP MENERIMA HINGGA 5 KLIEN BERSAMAAN'
          );
        };

        ws.onmessage = async (event) => {
          if (!isMounted) return;
          let data: Record<string, unknown> | null = null;
          try {
            data = JSON.parse(event.data) as Record<string, unknown>;
          } catch (err) {
            console.error('[MASTER-WS] Gagal parse pesan JSON:', err);
            return;
          }
          if (!data || typeof data.type !== 'string') return;

          const senderId = String(
            data.senderId || data.id || data.clientId || data.nodeId || ''
          ).replace('sigma-node-', '');

          console.log(
            `[MASTER-WS] Menerima pesan -> type: "${data.type}", senderId: "${senderId}", targetId: "${
              data.targetId || ''
            }"`
          );

          if (!senderId || senderId.toUpperCase() === 'MASTER') return;

          // A. Tangani Paket Telemetri GPS dari Klien
          if (data.type === 'SIGMA_TELEMETRY') {
            handlersRef.current.handleIncomingTelemetry(
              data as unknown as TelemetryPayload
            );
            return;
          }

          // B. Tangani Notifikasi Putusnya Klien spesifik (`senderId`)
          if (
            data.type === 'client_disconnected' ||
            data.type === 'CLIENT_DISCONNECTED'
          ) {
            console.log(`[MASTER-WS] Klien "${senderId}" terputus. Membersihkan slot.`);
            const oldPc = pcMap.get(senderId);
            if (oldPc) {
              try {
                oldPc.close();
              } catch {}
              pcMap.delete(senderId);
            }
            dcMap.delete(senderId);
            candQueueMap.delete(senderId);
            handlersRef.current.removeDisconnectedClient(senderId);
            return;
          }

          // C. Terima SDP OFFER dari Klien (`{ type: "offer", senderId, targetId: "MASTER", data: offer }`)
          const offerPayload = (data.data || data.sdp) as
            | RTCSessionDescriptionInit
            | undefined;
          if (
            (data.type === 'offer' || data.type === 'OFFER') &&
            offerPayload
          ) {
            const isExisting =
              pcMap.has(senderId) ||
              clientsRef.current.some((c) => c.nodeId === senderId);

            if (!isExisting && pcMap.size >= MAX_CLIENTS) {
              console.warn(
                `[MASTER-WS] Menolak Offer dari "${senderId}" karena slot penuh (${MAX_CLIENTS} Klien).`
              );
              return;
            }

            // Jika senderId yang sama melakukan re-offer, tutup sesi lamanya saja (bukan Klien lain)
            const prevPc = pcMap.get(senderId);
            if (prevPc) {
              try {
                prevPc.ontrack = null;
                prevPc.onicecandidate = null;
                prevPc.ondatachannel = null;
                prevPc.oniceconnectionstatechange = null;
                prevPc.onconnectionstatechange = null;
                prevPc.close();
              } catch {}
              pcMap.delete(senderId);
            }

            console.log(
              `[MASTER-WS] Membuat RTCPeerConnection baru untuk senderId="${senderId}"`
            );
            const pc = new RTCPeerConnection(RTC_CONFIG);
            // Simpan di dalam `peerConnections.current` (Map di dalam useRef)
            pcMap.set(senderId, pc);
            // Tandai bahwa remoteDescription belum selesai diset (cegah race condition ICE Candidate)
            remoteDescReadyRef.current.set(senderId, false);
            if (!candQueueMap.has(senderId)) {
              candQueueMap.set(senderId, []);
            }

            handlersRef.current.upsertConnectedClient(senderId, {
              lastTelemetryAt: Date.now(),
            });
            setConnectionBanner(
              `HANDSHAKE MULTI-PEER: MENERIMA OFFER DARI (${senderId}) · TOTAL: ${pcMap.size} KLIEN`
            );

            // Kirim ICE Candidate Master kembali spesifik ke `targetId: senderId`
            pc.onicecandidate = (iceEvent) => {
              if (iceEvent.candidate && ws.readyState === WebSocket.OPEN) {
                const candidateJson = iceEvent.candidate.toJSON();
                const candidatePacket = {
                  type: 'candidate',
                  senderId: 'MASTER',
                  targetId: senderId,
                  data: candidateJson,
                };
                console.log(
                  `[MASTER-WS] Mengirim ICE Candidate ke targetId="${senderId}"`
                );
                ws.send(JSON.stringify(candidatePacket));
              }
            };

            // Saat `ontrack` dari Klien masuk, tambahkan `{ id: senderId, stream }` ke `clientStreams`
            pc.ontrack = (trackEvent: RTCTrackEvent) => {
              console.log(
                `[MASTER-WS] EVENT ontrack DITERIMA dari senderId="${senderId}"! Track kind="${trackEvent.track.kind}"`
              );
              const inboundStream =
                trackEvent.streams && trackEvent.streams[0]
                  ? trackEvent.streams[0]
                  : new MediaStream([trackEvent.track]);

              setClientStreams((prev) => {
                const exists = prev.some((item) => item.id === senderId);
                if (exists) {
                  return prev.map((item) =>
                    item.id === senderId
                      ? { id: senderId, stream: inboundStream }
                      : item
                  );
                }
                return [...prev, { id: senderId, stream: inboundStream }];
              });

              handlersRef.current.attachWebRTCStreamToNode(
                senderId,
                inboundStream
              );
              setConnectionBanner(
                `MULTI-PEER AUDIO AKTIF: KLIEN (${senderId})`
              );
            };

            // Tangkap RTCDataChannel untuk GPS spesifik per `senderId`
            pc.ondatachannel = (dcEvent) => {
              console.log(
                `[MASTER-WS] DataChannel terbuka dari senderId="${senderId}"`
              );
              const channel = dcEvent.channel;
              dcMap.set(senderId, channel);
              channel.onmessage = (msgEv) => {
                try {
                  const parsed = JSON.parse(msgEv.data) as TelemetryPayload;
                  handlersRef.current.handleIncomingTelemetry(parsed);
                } catch {}
              };
            };

            // Cleanup otomatis jika `senderId` ini terputus
            pc.oniceconnectionstatechange = () => {
              if (pcMap.get(senderId) !== pc) return;
              const st = pc.iceConnectionState;
              console.log(
                `[MASTER-WS] iceConnectionState untuk "${senderId}": ${st}`
              );
              if (st === 'failed' || st === 'closed') {
                pcMap.delete(senderId);
                dcMap.delete(senderId);
                candQueueMap.delete(senderId);
                remoteDescReadyRef.current.delete(senderId);
                handlersRef.current.removeDisconnectedClient(senderId);
              }
            };

            try {
              await pc.setRemoteDescription(
                new RTCSessionDescription(offerPayload)
              );
              // Setelah setRemoteDescription() selesai dieksekusi (resolved promise),
              // tandai siap dan masukkan semua candidate yang sempat tertahan di antrean
              remoteDescReadyRef.current.set(senderId, true);

              const candidateQueue = candQueueMap.get(senderId) || [];
              while (candidateQueue.length > 0) {
                const nextCand = candidateQueue.shift();
                if (nextCand) {
                  console.log(
                    `[MASTER-WS] Memasukkan ICE Candidate dari antrean untuk "${senderId}"`
                  );
                  await pc
                    .addIceCandidate(new RTCIceCandidate(nextCand))
                    .catch((err) => {
                      console.error(
                        `[MASTER-WS] Gagal addIceCandidate dari antrean untuk "${senderId}":`,
                        err
                      );
                    });
                }
              }

              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);

              if (ws.readyState === WebSocket.OPEN && pc.localDescription) {
                const answerPacket = {
                  type: 'answer',
                  senderId: 'MASTER',
                  targetId: senderId,
                  data: {
                    type: pc.localDescription.type,
                    sdp: pc.localDescription.sdp,
                  },
                };
                console.log(
                  `[MASTER-WS] Mengirim ANSWER balik ke targetId="${senderId}"`
                );
                ws.send(JSON.stringify(answerPacket));
              }
            } catch (err) {
              console.error(
                `[MASTER-WS] Gagal memproses Offer dari "${senderId}":`,
                err
              );
            }
            return;
          }

          // D. ICE CANDIDATE QUEUEING (PENCEGAH RACE CONDITION):
          // Saat menerima pesan { type: "candidate" } dari WebSocket, JANGAN langsung memanggil
          // peerConnection.addIceCandidate() sebelum remoteDescription siap.
          const candidatePayload = (data.data || data.candidate) as
            | RTCIceCandidateInit
            | undefined;
          if (
            (data.type === 'candidate' || data.type === 'ICE_CANDIDATE') &&
            candidatePayload
          ) {
            const pc = pcMap.get(senderId);
            const isRemoteReady =
              Boolean(pc && pc.remoteDescription && pc.remoteDescription.type) &&
              remoteDescReadyRef.current.get(senderId) === true;

            if (pc && isRemoteReady) {
              console.log(
                `[MASTER-WS] Menambahkan ICE Candidate langsung ke peerConnections.get("${senderId}")`
              );
              await pc
                .addIceCandidate(new RTCIceCandidate(candidatePayload))
                .catch((err) => {
                  console.error(
                    `[MASTER-WS] Gagal addIceCandidate untuk "${senderId}":`,
                    err
                  );
                });
            } else {
              console.log(
                `[MASTER-WS] Mengantrekan ICE Candidate untuk "${senderId}" ke candidateQueue (remoteDescription belum siap)`
              );
              const candidateQueue = candQueueMap.get(senderId) || [];
              candidateQueue.push(candidatePayload);
              candQueueMap.set(senderId, candidateQueue);
            }
          }
        };

        ws.onclose = () => {
          if (!isMounted) return;
          wsFailCount++;
          if (wsFailCount < 3) {
            reconnectTimer = window.setTimeout(connectMasterWebSocket, 3000);
          }
        };

        ws.onerror = () => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.close();
            } catch {}
          }
        };
      } catch {
        wsFailCount++;
      }
    };

    connectMasterWebSocket();

    return () => {
      isMounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
      }
      pcMap.forEach((pc) => {
        try {
          pc.close();
        } catch {}
      });
      pcMap.clear();
      dcMap.clear();
      candQueueMap.clear();
    };
  }, []);

  // Initialize Master PeerJS Broker (Utama untuk Vercel + Jaringan Seluler Samsung A26)
  useEffect(() => {
    let isMounted = true;
    const secondaryPeers: Peer[] = [];

    const bindPeerListeners = (peerInstance: Peer, isPrimary = false) => {
      peerInstance.on('open', (id) => {
        if (!isMounted) return;
        if (isPrimary || !peerRef.current || !peerRef.current.open) {
          peerRef.current = peerInstance;
          setMasterPeerId(id);
        }
        setConnectionBanner(
          `MASTER ONLINE (${id}) · SIAP MENERIMA KONEKSI AUDIO & GPS REAL-TIME`
        );
      });

      peerInstance.on('call', (incomingCall) => {
        if (!isMounted) return;
        const metaNodeId = String(
          incomingCall.metadata?.nodeId ||
            incomingCall.peer.replace('sigma-node-', '')
        ).trim();

        if (metaNodeId) {
          const isExisting = clientsRef.current.some(
            (c) => c.nodeId === metaNodeId
          );
          if (!isExisting && clientsRef.current.length >= MAX_CLIENTS) return;

          // Jawab panggilan terlebih dahulu agar incomingCall.peerConnection terbentuk oleh PeerJS,
          // kemudian pasang listener track tanpa menimpa handler internal PeerJS!
          incomingCall.answer();
          registerMediaConnection(metaNodeId, incomingCall);
        }
      });

      peerInstance.on('connection', (conn) => {
        if (!isMounted) return;
        const metaNodeId = String(
          conn.metadata?.nodeId || conn.peer.replace('sigma-node-', '')
        ).trim();
        if (metaNodeId) {
          const isExisting = clientsRef.current.some(
            (c) => c.nodeId === metaNodeId
          );
          if (!isExisting && clientsRef.current.length >= MAX_CLIENTS) return;
          registerDataConnection(metaNodeId, conn);
        }
      });

      peerInstance.on('disconnected', () => {
        if (!isMounted) return;
        try {
          peerInstance.reconnect();
        } catch {}
      });
    };

    const primaryMasterId = 'sigma-master-main';
    const peer = new Peer(primaryMasterId, {
      debug: 0,
      config: RTC_CONFIG,
      pingInterval: 5000,
    });
    peerRef.current = peer;
    bindPeerListeners(peer, true);

    peer.on('error', (err: { type?: string }) => {
      if (!isMounted) return;
      if (err?.type === 'unavailable-id') {
        // Gunakan slot deterministik 'sigma-master-slot-1' yang juga di-dial otomatis oleh Client!
        const slot1Peer = new Peer('sigma-master-slot-1', {
          debug: 0,
          config: RTC_CONFIG,
          pingInterval: 5000,
        });
        secondaryPeers.push(slot1Peer);
        peerRef.current = slot1Peer;
        bindPeerListeners(slot1Peer, true);

        slot1Peer.on('error', (slotErr: { type?: string }) => {
          if (!isMounted) return;
          if (slotErr?.type === 'unavailable-id') {
            const backupId = `sigma-master-${Math.floor(
              1000 + Math.random() * 9000
            )}`;
            const backupPeer = new Peer(backupId, {
              debug: 0,
              config: RTC_CONFIG,
              pingInterval: 5000,
            });
            secondaryPeers.push(backupPeer);
            peerRef.current = backupPeer;
            bindPeerListeners(backupPeer, true);
          }
        });
      }
    });

    // Watchdog 3.5 detik: Jika ada Client yang sudah terhubung DataChannel namun stream audionya
    // belum masuk (misal karena user baru saja mengklik Allow Mic di HP Samsung A26),
    // minta ulang & panggil stream audio dari Client tersebut secara otomatis!
    const audioWatchdog = window.setInterval(() => {
      if (!isMounted) return;
      const activePeer = peerRef.current;
      if (!activePeer || !activePeer.open) return;

      clientsRef.current.forEach((client) => {
        if (client.connectionStatus === 'connected' && !client.hasAudioStream) {
          const dc = dataConnsRef.current.get(client.nodeId);
          if (dc && dc.open) {
            try {
              dc.send({
                type: 'SIGMA_REQUEST_AUDIO_STREAM',
                masterPeerId: activePeer.id,
              });
            } catch {}
          }
          const existingCall = mediaCallsRef.current.get(client.nodeId);
          if (!existingCall || !existingCall.open) {
            try {
              const offerStream = createMasterOfferDummyStream();
              const call = activePeer.call(
                `sigma-node-${client.nodeId}`,
                offerStream
              );
              if (call) {
                registerMediaConnection(client.nodeId, call);
              }
            } catch {}
          }
        }
      });
    }, 3500);

    const pipelines = pipelinesRef.current;
    const dataConns = dataConnsRef.current;
    const mediaCalls = mediaCallsRef.current;

    return () => {
      isMounted = false;
      clearInterval(audioWatchdog);
      pipelines.forEach((entry) => {
        if (entry.recorder && entry.recorder.state === 'recording') {
          try {
            entry.recorder.stop();
          } catch {}
        }
      });
      pipelines.clear();
      dataConns.forEach((c) => c.close());
      mediaCalls.forEach((c) => c.close());
      dataConns.clear();
      mediaCalls.clear();
      try {
        peer.destroy();
      } catch {}
      secondaryPeers.forEach((p) => {
        try {
          p.destroy();
        } catch {}
      });
    };
  }, [
    attachWebRTCStreamToNode,
    createMasterOfferDummyStream,
    registerDataConnection,
    registerMediaConnection,
  ]);

  // Real-Time Canvas Waveform Renderer + VOX Auto-Record Engine
  useEffect(() => {
    let rafId: number;
    let lastStateSync = performance.now();
    const silenceTracker = new Map<string, number>();

    const renderWaveforms = (now: number) => {
      const shouldSyncState = now - lastStateSync >= 180;
      const rmsUpdates = new Map<
        string,
        { rms: number; peak: number; silenceMs: number }
      >();

      clientsRef.current.forEach((client) => {
        if (client.connectionStatus !== 'connected') return;

        const canvas = canvasesRef.current.get(client.nodeId);
        const entry = pipelinesRef.current.get(client.nodeId);

        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const width = canvas.width;
            const height = canvas.height;
            ctx.clearRect(0, 0, width, height);

            const midY = height / 2;
            ctx.strokeStyle = 'rgba(0, 255, 255, 0.14)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(0, midY);
            ctx.lineTo(width, midY);
            ctx.stroke();
            ctx.setLineDash([]);

            if (entry) {
              const bufferLen = entry.analyser.frequencyBinCount;
              const timeData = new Uint8Array(bufferLen);
              const freqData = new Uint8Array(bufferLen);
              entry.analyser.getByteTimeDomainData(timeData);
              entry.analyser.getByteFrequencyData(freqData);

              let sumSq = 0;
              let maxPeak = 0;
              for (let i = 0; i < bufferLen; i++) {
                const norm = (timeData[i] - 128) / 128;
                const abs = Math.abs(norm);
                sumSq += norm * norm;
                if (abs > maxPeak) maxPeak = abs;
              }
              const rms = Math.min(100, Math.round(Math.sqrt(sumSq / bufferLen) * 260));
              const peak = Math.min(100, Math.round(maxPeak * 220));

              const barCount = 58;
              const step = Math.floor(bufferLen / barCount);
              const barSpacing = width / barCount;
              const barWidth = Math.max(2, barSpacing * 0.56);

              for (let i = 0; i < barCount; i++) {
                const sampleIdx = i * step;
                const timeVal = Math.abs(timeData[sampleIdx] - 128) / 128;
                const freqVal = freqData[sampleIdx] / 255;

                const edgeWindow = Math.sin((i / (barCount - 1)) * Math.PI);
                const combined = (timeVal * 0.65 + freqVal * 0.55) * edgeWindow;
                const barHalfHeight = Math.max(
                  1.5,
                  Math.min(midY - 3, combined * (height * 0.88))
                );

                const x = i * barSpacing + (barSpacing - barWidth) / 2;
                ctx.fillStyle = combined > 0.35 ? '#00FFFF' : '#06b6d4';
                ctx.fillRect(x, midY - barHalfHeight, barWidth, barHalfHeight * 2);
              }

              if (shouldSyncState) {
                const dt = now - lastStateSync;
                let curSilence = silenceTracker.get(client.nodeId) || 0;

                if (autoRecordModeRef.current === 'VOX') {
                  if (rms >= voxThresholdRef.current) {
                    curSilence = 0;
                    if (!entry.recorder || entry.recorder.state !== 'recording') {
                      startNodeRecording(client.nodeId, 'VOX');
                    }
                  } else if (entry.recorder && entry.recorder.state === 'recording') {
                    curSilence += dt;
                    if (curSilence >= 10000) {
                      stopNodeRecording(client.nodeId);
                      curSilence = 0;
                    }
                  }
                } else {
                  curSilence = 0;
                }

                silenceTracker.set(client.nodeId, curSilence);
                rmsUpdates.set(client.nodeId, { rms, peak, silenceMs: curSilence });
              }
            }
          }
        }
      });

      if (shouldSyncState) {
        lastStateSync = now;
        if (rmsUpdates.size > 0) {
          setClients((prev) =>
            prev.map((c) => {
              const u = rmsUpdates.get(c.nodeId);
              if (!u) return c;
              return {
                ...c,
                volumeLevel: u.rms,
                peakLevel: u.peak,
                voxSilenceMs: u.silenceMs,
              };
            })
          );
        }
      }

      rafId = requestAnimationFrame(renderWaveforms);
    };

    rafId = requestAnimationFrame(renderWaveforms);
    return () => cancelAnimationFrame(rafId);
  }, [startNodeRecording, stopNodeRecording]);

  // Sinkronisasi Gain, Solo, dan Mute ke elemen <audio autoPlay playsInline> & WebAudio GainNode
  useEffect(() => {
    clients.forEach((c) => {
      const shouldPlayToSpeaker =
        !masterMuted && (soloNodeId === null || soloNodeId === c.nodeId);

      // Update elemen <audio autoPlay playsInline> (volume 0 agar tidak bocor suara mentah sebelum DSP)
      const audioEl = nodeAudioElsRef.current.get(c.nodeId);
      if (audioEl) {
        audioEl.muted = !shouldPlayToSpeaker;
        audioEl.volume = 0;
      }

      // Update WebAudio GainNode & SpeakerGain
      const entry = pipelinesRef.current.get(c.nodeId);
      if (entry && audioCtxRef.current) {
        if (audioCtxRef.current.state === 'suspended') {
          audioCtxRef.current.resume().catch(() => {});
        }
        const now = audioCtxRef.current.currentTime;
        const linearGain = Math.pow(10, c.gainDb / 20);
        entry.gainNode.gain.setTargetAtTime(linearGain, now, 0.04);
        entry.speakerGain.gain.setTargetAtTime(
          shouldPlayToSpeaker ? 1.0 : 0.0,
          now,
          0.04
        );
      }
    });
  }, [clients, soloNodeId, masterMuted]);

  const handleSelectAutoRecordMode = (mode: AutoRecordMode) => {
    setAutoRecordMode(mode);
    if (mode === 'IMMEDIATE') {
      clientsRef.current.forEach((c) => {
        if (c.connectionStatus === 'connected' && c.hasAudioStream) {
          startNodeRecording(c.nodeId, 'IMMEDIATE');
        }
      });
    } else if (mode === 'OFF') {
      clientsRef.current.forEach((c) => {
        if (c.isRecording && c.recordingTrigger !== 'MANUAL') {
          stopNodeRecording(c.nodeId);
        }
      });
    }
  };

  const handleToggleSolo = (nodeId: string) => {
    unlockAllAudioPlayback();
    if (soloNodeId === nodeId) {
      setSoloNodeId(null);
    } else {
      setSoloNodeId(nodeId);
      if (masterMuted) setMasterMuted(false);
    }
  };

  const dispatchRemoteNodeCommand = useCallback(
    (
      nodeId: string,
      commandType: 'SET_GAIN' | 'SET_MUTE' | 'EMERGENCY_WIPE',
      value?: number | boolean
    ) => {
      // 1. Kirim via Native RTCDataChannel
      const nativeDc = nativeDataChannelsRef.current.get(nodeId);
      if (nativeDc) {
        sendCommand(nativeDc, commandType, value);
      }

      // 2. Kirim via PeerJS DataConnection
      const peerConn = dataConnsRef.current.get(nodeId);
      if (peerConn) {
        sendCommand(peerConn, commandType, value);
      }

      // 3. Kirim via WebSocket Signaling Server (`targetId: nodeId`)
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(
            JSON.stringify({
              type: commandType,
              role: 'MASTER',
              senderId: 'MASTER',
              targetId: nodeId,
              target: nodeId,
              value,
              timestamp: Date.now(),
            })
          );
        } catch {}
      }
    },
    []
  );

  const handleCycleGain = (nodeId: string) => {
    unlockAllAudioPlayback();
    setClients((prev) =>
      prev.map((c) => {
        if (c.nodeId !== nodeId) return c;
        const currentIdx = GAIN_STEPS.indexOf(c.gainDb);
        const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % GAIN_STEPS.length : 0;
        const nextGainDb = GAIN_STEPS[nextIdx];
        const entry = pipelinesRef.current.get(nodeId);
        if (entry && audioCtxRef.current) {
          const linearGain = Math.pow(10, nextGainDb / 20);
          entry.gainNode.gain.setTargetAtTime(
            linearGain,
            audioCtxRef.current.currentTime,
            0.02
          );
        }
        // Basis sensitivitas GainNode Klien = 5.0x pada 0dB, meningkat sesuai step dB
        const remoteLinearGain = Number(
          (5.0 * Math.pow(10, nextGainDb / 20)).toFixed(2)
        );
        dispatchRemoteNodeCommand(nodeId, 'SET_GAIN', remoteLinearGain);
        setConnectionBanner(
          `TELEPHONY DSP GAIN (${nodeId}): +${nextGainDb}dB (MASTER ${(Math.pow(10, nextGainDb / 20)).toFixed(1)}x)`
        );
        return { ...c, gainDb: nextGainDb };
      })
    );
  };

  const handleSetClientGainDb = (nodeId: string, nextGainDb: number) => {
    unlockAllAudioPlayback();
    const entry = pipelinesRef.current.get(nodeId);
    if (entry && audioCtxRef.current) {
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }
      const linearGain = Math.pow(10, nextGainDb / 20);
      entry.gainNode.gain.setTargetAtTime(
        linearGain,
        audioCtxRef.current.currentTime,
        0.015
      );
    }
    setClients((prev) =>
      prev.map((c) => (c.nodeId === nodeId ? { ...c, gainDb: nextGainDb } : c))
    );
  };

  const handleToggleRemoteMicMute = (nodeId: string) => {
    unlockAllAudioPlayback();
    setClients((prev) =>
      prev.map((c) => {
        if (c.nodeId !== nodeId) return c;
        const nextMuted = !c.remoteMuted;
        dispatchRemoteNodeCommand(nodeId, 'SET_MUTE', nextMuted);
        setConnectionBanner(
          `REMOTE MIC ${nextMuted ? 'MUTED' : 'UNMUTED'} ON PASSIVE CLIENT (${nodeId})`
        );
        return { ...c, remoteMuted: nextMuted };
      })
    );
  };

  const handleEmergencyWipeNode = (nodeId: string) => {
    dispatchRemoteNodeCommand(nodeId, 'EMERGENCY_WIPE', true);
    triggerEmergencyWipe(dataConnsRef.current.get(nodeId));
    setConnectionBanner(`EMERGENCY_WIPE TRIGGERED FOR PASSIVE CLIENT (${nodeId})`);
    setTimeout(() => {
      disconnectNode(nodeId);
    }, 180);
  };

  const handleEmergencyWipeAll = () => {
    connectedClients.forEach((c) => {
      dispatchRemoteNodeCommand(c.nodeId, 'EMERGENCY_WIPE', true);
      triggerEmergencyWipe(dataConnsRef.current.get(c.nodeId));
      setTimeout(() => {
        disconnectNode(c.nodeId);
      }, 180);
    });
    setConnectionBanner('EMERGENCY_WIPE BROADCAST SENT TO ALL PASSIVE CLIENTS');
  };

  const handleToggleRec = (client: ConnectedClient) => {
    unlockAllAudioPlayback();
    if (client.isRecording) {
      stopNodeRecording(client.nodeId);
    } else {
      startNodeRecording(client.nodeId, 'MANUAL');
    }
  };

  const connectedClients = clients.filter((c) => c.connectionStatus === 'connected');
  const connectedWithGps = connectedClients.filter(
    (c) => typeof c.lat === 'number' && typeof c.lng === 'number'
  );

  const activeCountFormatted = String(connectedClients.length).padStart(2, '0');

  const activeMapCenter: [number, number] =
    connectedWithGps.length > 0
      ? [connectedWithGps[0].lat!, connectedWithGps[0].lng!]
      : [masterCoords.lat, masterCoords.lng];

  const activeMapZoom =
    connectedWithGps.length > 0 ? 15 : masterCoords.hasLock ? 13 : 5;

  const polylineCoords: [number, number][] = connectedWithGps.map((c) => [
    c.lat!,
    c.lng!,
  ]);

  return (
    <div className="min-h-screen bg-[#02060d] text-cyan-50 font-mono-tactical flex flex-col select-none overflow-x-hidden">
      {/* Barcode Pairing & Share APK Modal */}
      <BarcodeModal
        isOpen={barcodeModalOpen}
        onClose={() => setBarcodeModalOpen(false)}
        initialTab={barcodeModalTab}
        defaultNodeId={barcodeTargetNodeId}
        masterPeerId={masterPeerId}
        onScanNodeId={(scannedId) => {
          connectToRemoteNode(scannedId);
        }}
      />

      {/* Render daftar clientStreams menjadi elemen <audio autoPlay playsInline> terpisah per Klien */}
      <div
        id="audio-container"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          width: '1px',
          height: '1px',
          opacity: 0.01,
          pointerEvents: 'none',
          overflow: 'hidden',
          zIndex: -1,
        }}
      >
        {clientStreams.map((item) => {
          const isMuted =
            masterMuted || (soloNodeId !== null && soloNodeId !== item.id);
          return (
            <ClientAudioElement
              key={item.id}
              id={item.id}
              stream={item.stream}
              muted={isMuted}
              onRegisterEl={(clientId, el) => {
                if (el) {
                  nodeAudioElsRef.current.set(clientId, el);
                } else {
                  nodeAudioElsRef.current.delete(clientId);
                }
              }}
              onAutoplayBlocked={() => setAutoplayBlocked(true)}
              onAutoplaySuccess={() => setAutoplayBlocked(false)}
            />
          );
        })}
      </div>
      <div id="master-multi-audio-stage" />

      {/* Hidden audio element for Recordings Log playback */}
      <audio
        ref={audioPlayerRef}
        onEnded={() => setPlayingClipId(null)}
        className="hidden"
      />

      {/* Banner pembuka blokir Autoplay Policy apabila browser menahan suara */}
      {autoplayBlocked && (
        <div className="bg-amber-500/20 border-b border-amber-400 px-4 py-2 flex items-center justify-between text-xs text-amber-200">
          <span>
            Browser menahan pemutaran suara otomatis (Autoplay Policy). Klik tombol di
            samping untuk mengaktifkan speaker Master.
          </span>
          <button
            onClick={unlockAllAudioPlayback}
            className="px-3 py-1 bg-amber-400 text-slate-950 font-bold rounded cursor-pointer"
          >
            AKTIFKAN SUARA SPEAKER
          </button>
        </div>
      )}

      {/* TOP TACTICAL HEADER: Logo TNI AU di Pojok Kiri Atas & Logo Petir di Pojok Kanan Atas */}
      <header className="border-b border-cyan-500/30 bg-[#040a14]/95 px-3 sm:px-5 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {/* Logo TNI AU di pojok kiri atas */}
          <img
            src="/assets/aistudio/images__10__b9efa126.jpeg"
            alt="Logo TNI AU"
            referrerPolicy="no-referrer"
            className="w-6 h-6 sm:w-7 sm:h-7 object-contain rounded-full border border-cyan-500/40 bg-black p-0.5 shrink-0"
          />

          <button
            onClick={onExit}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-cyan-400 hover:text-cyan-200 bg-cyan-950/40 border border-cyan-500/30 rounded transition-colors cursor-pointer"
            title="Return to Mode Selection"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">MODE</span>
          </button>

          <div>
            <h1 className="font-display-tactical text-xl sm:text-2xl md:text-3xl font-bold tracking-wider text-cyan-300 text-glow-cyan leading-none">
              S.I.G.M.A DISKOMLEKAU
            </h1>
            <p className="text-[10px] sm:text-xs tracking-[0.2em] text-slate-300 uppercase mt-0.5">
              SYSTEM GATEWAY &amp; MONITORING AUDIO · STEALTH INTELLIGENCE GATEWAY
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="bg-[#071324] border border-cyan-500/35 rounded px-2.5 py-1 text-[11px] leading-tight">
            <div className="text-slate-300">
              OP-STATUS:{' '}
              <span
                className={
                  connectedClients.length > 0
                    ? 'text-emerald-400 font-bold'
                    : 'text-amber-400 font-bold'
                }
              >
                {connectedClients.length > 0 ? 'FULL ACTIVE' : 'STANDBY'}
              </span>
            </div>
            <div className="text-slate-300">
              MONITORED:{' '}
              <span className="text-cyan-300 font-bold">
                {activeCountFormatted}/05 NODES
              </span>
            </div>
          </div>

          <div className="hidden xl:block bg-[#071324] border border-cyan-500/35 rounded px-2.5 py-1 text-[11px] leading-tight">
            <div className="text-slate-300">
              CRYPT: <span className="text-cyan-300 font-bold">AES-GCM-256</span>
            </div>
            <div className="text-slate-300">
              MONITORED:{' '}
              <span className="text-cyan-300 font-bold">
                {activeCountFormatted}/05 NODES
              </span>
            </div>
          </div>

          <div className="bg-[#06101e] border border-cyan-400/50 rounded px-3 py-1.5 text-lg sm:text-xl font-bold tracking-wider text-cyan-200 font-mono-tactical">
            {clockStr}
          </div>

          <PWAInstallButton />

          {/* Logo Petir Diskomlekau di pojok kanan atas (berseberangan dengan Logo TNI AU) */}
          <img
            src="/assets/aistudio/1794622160588-picsay_109de27f.png"
            alt="Logo Petir Diskomlekau"
            referrerPolicy="no-referrer"
            className="w-6 h-6 sm:w-7 sm:h-7 object-contain rounded-full border border-cyan-500/40 bg-[#040d1a] p-0.5 shrink-0"
          />
        </div>
      </header>

      {/* SECONDARY TACTICAL TOOLBAR */}
      <div className="border-b border-cyan-500/20 bg-[#050d1a] px-3 sm:px-5 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Disc className="w-3.5 h-3.5 text-red-400" />
            <span>AUTO-RECORD MODE:</span>
          </span>

          <div className="flex items-center bg-[#02070f] p-0.5 rounded border border-cyan-500/30">
            <button
              onClick={() => handleSelectAutoRecordMode('IMMEDIATE')}
              className={`px-2.5 py-1 text-[11px] rounded transition-colors cursor-pointer whitespace-nowrap ${
                autoRecordMode === 'IMMEDIATE'
                  ? 'bg-red-500/25 text-red-300 border border-red-500/50 font-semibold'
                  : 'text-slate-400 hover:text-cyan-200'
              }`}
            >
              IMMEDIATE AUTO-REC
            </button>
            <button
              onClick={() => handleSelectAutoRecordMode('VOX')}
              className={`px-2.5 py-1 text-[11px] rounded transition-colors cursor-pointer whitespace-nowrap ${
                autoRecordMode === 'VOX'
                  ? 'bg-amber-500/25 text-amber-300 border border-amber-500/50 font-semibold'
                  : 'text-slate-400 hover:text-cyan-200'
              }`}
            >
              VOX AUTO-REC (10s SILENCE STOP)
            </button>
            <button
              onClick={() => handleSelectAutoRecordMode('OFF')}
              className={`px-2.5 py-1 text-[11px] rounded transition-colors cursor-pointer whitespace-nowrap ${
                autoRecordMode === 'OFF'
                  ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 font-semibold'
                  : 'text-slate-400 hover:text-cyan-200'
              }`}
            >
              MANUAL ONLY
            </button>
          </div>

          {autoRecordMode === 'VOX' && (
            <div className="flex items-center gap-2 bg-[#071426] border border-amber-500/40 px-2.5 py-1 rounded text-[11px]">
              <span className="text-amber-300">VOX TRIG: {voxThreshold}%</span>
              <input
                type="range"
                min={8}
                max={75}
                value={voxThreshold}
                onChange={(e) => setVoxThreshold(Number(e.target.value))}
                className="w-20 accent-amber-400 cursor-pointer"
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              unlockAllAudioPlayback();
              setMasterMuted((m) => !m);
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded border transition-colors cursor-pointer whitespace-nowrap ${
              !masterMuted
                ? 'bg-emerald-950/60 border-emerald-500/60 text-emerald-300'
                : 'bg-[#071220] border-slate-700 text-slate-400 hover:text-cyan-200'
            }`}
            title="Toggle Live Audio Speaker Output"
          >
            {masterMuted ? (
              <VolumeX className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
            )}
            <span>{masterMuted ? 'SPEAKER: MUTED' : 'SPEAKER: LIVE'}</span>
          </button>

          {soloNodeId && (
            <button
              onClick={() => setSoloNodeId(null)}
              className="px-2 py-1 text-[11px] bg-cyan-500/25 border border-cyan-400 text-cyan-200 rounded cursor-pointer"
            >
              SOLO: {soloNodeId} (CLEAR)
            </button>
          )}

          <button
            onClick={() => {
              setBarcodeTargetNodeId('');
              setBarcodeModalTab('CLIENT_JOIN');
              setBarcodeModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold bg-cyan-950/80 border border-cyan-400/60 text-cyan-200 rounded hover:bg-cyan-500/25 transition-colors cursor-pointer whitespace-nowrap"
          >
            <QrCode className="w-3.5 h-3.5 text-cyan-400" />
            <span>JOIN CLIENT BARCODE</span>
          </button>

          <button
            onClick={() => {
              setBarcodeModalTab('SHARE_APK');
              setBarcodeModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold bg-emerald-950/80 border border-emerald-400/60 text-emerald-200 rounded hover:bg-emerald-500/25 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Smartphone className="w-3.5 h-3.5 text-emerald-400" />
            <span>SHARE APK BARCODE</span>
          </button>

          <button
            onClick={() => setShowRecordingsDrawer(true)}
            className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold bg-cyan-950/80 border border-cyan-400/60 text-cyan-200 rounded hover:bg-cyan-500/25 transition-colors cursor-pointer whitespace-nowrap"
          >
            <FolderDown className="w-3.5 h-3.5 text-cyan-400" />
            <span>RECORDINGS LOG ({recordings.length})</span>
          </button>

          {connectedClients.length > 0 && (
            <button
              onClick={handleEmergencyWipeAll}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold bg-red-950/90 border border-red-500/80 text-red-200 rounded hover:bg-red-600/30 transition-colors cursor-pointer whitespace-nowrap"
              title="Emergency Wipe All Connected Passive Clients"
            >
              <Skull className="w-3.5 h-3.5 text-red-400" />
              <span>WIPE ALL</span>
            </button>
          )}
        </div>
      </div>

      {/* MAIN TACTICAL WORKSPACE */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 p-3 sm:p-4">
        {/* LEFT COLUMN: CONNECTED REAL CLIENTS ONLY + CONNECT NODE BAR */}
        <div className="lg:col-span-6 xl:col-span-5 flex flex-col gap-2.5 order-2 lg:order-1">
          {connectedClients.length === 0 ? (
            <div className="flex-1 min-h-[280px] rounded border border-cyan-500/30 bg-[#050c17]/90 p-6 flex flex-col items-center justify-center text-center space-y-4">
              <div className="w-12 h-12 rounded-full border border-cyan-500/40 bg-cyan-950/30 flex items-center justify-center">
                <Radio className="w-6 h-6 text-cyan-400 animate-pulse" />
              </div>
              <div className="space-y-1.5 max-w-md">
                <div className="text-sm font-bold tracking-widest text-cyan-300">
                  STANDBY: MENUNGGU KONEKSI TELEMETRI NODE...
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Belum ada perangkat Client/Node yang terhubung via WebRTC. Masukkan 4-digit
                  ID Node pada panel di bawah atau gunakan fitur{' '}
                  <span className="text-cyan-300">JOIN CLIENT BARCODE</span> untuk menyambungkan
                  HP Client secara real-time.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                <button
                  onClick={() => {
                    setBarcodeTargetNodeId('');
                    setBarcodeModalTab('CLIENT_JOIN');
                    setBarcodeModalOpen(true);
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-cyan-500/20 border border-cyan-400 text-cyan-200 rounded hover:bg-cyan-500/30 cursor-pointer"
                >
                  <QrCode className="w-3.5 h-3.5" />
                  <span>TAMPILKAN QR PAIRING CLIENT</span>
                </button>
                <button
                  onClick={() => {
                    setBarcodeModalTab('SCANNER');
                    setBarcodeModalOpen(true);
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-amber-500/20 border border-amber-400 text-amber-200 rounded hover:bg-amber-500/30 cursor-pointer"
                >
                  <ScanLine className="w-3.5 h-3.5" />
                  <span>SCAN BARCODE CLIENT</span>
                </button>
              </div>
            </div>
          ) : (
            connectedClients.map((client) => {
              const isSolo = soloNodeId === client.nodeId;
              const gainBarPercent = Math.min(
                100,
                Math.round(((client.gainDb + 6) / 30) * 100)
              );

              return (
                <div
                  key={client.nodeId}
                  className="rounded border bg-[#06101e]/95 border-cyan-500/45 border-glow-cyan px-3.5 py-2.5 transition-all"
                >
                  {/* Elemen <audio autoplay playsinline> diinjeksikan secara dinamis ke DOM oleh handleIncomingAudio() */}

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm sm:text-base font-bold tracking-wide text-slate-100">
                        {client.label} ({client.nodeId}) -{' '}
                        <span className="text-cyan-400">ACTIVE</span>
                      </span>
                      <span className="text-[10px] text-emerald-300 flex items-center gap-1">
                        <Wifi className="w-3 h-3" /> RTCPeerConnection
                      </span>
                    </div>

                    <div className="flex items-center gap-3">
                      {client.isRecording && (
                        <div className="flex items-center gap-1.5 text-xs font-bold text-red-400 animate-pulse">
                          <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block shadow-[0_0_8px_#ef4444]" />
                          <span>
                            {client.recordingTrigger === 'MANUAL'
                              ? 'REC'
                              : client.recordingTrigger === 'VOX'
                              ? 'VOX-REC'
                              : 'AUTO-REC'}
                          </span>
                        </div>
                      )}

                      <div className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-emerald-400">
                        <span className="w-2.5 h-2.5 rounded-full inline-block bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399]" />
                        <span>CONNECTED</span>
                      </div>

                      <button
                        onClick={() => disconnectNode(client.nodeId)}
                        className="p-1 text-slate-400 hover:text-red-400 cursor-pointer"
                        title="Putuskan Koneksi Node"
                      >
                        <PhoneOff className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-1 flex items-center justify-between text-[11px] text-slate-300">
                    <div className="flex items-center gap-3">
                      <span className="text-slate-300">Visualizer audio WebRTC</span>
                      <div className="hidden sm:flex items-center gap-2 text-[10px] text-cyan-300">
                        <span className="flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          GAIN
                        </span>
                        <div className="w-8 h-1.5 bg-slate-800 rounded overflow-hidden">
                          <div
                            className="h-full bg-cyan-400"
                            style={{ width: `${gainBarPercent}%` }}
                          />
                        </div>
                        <span>VOL</span>
                        <div className="w-10 h-1.5 bg-slate-800 rounded overflow-hidden">
                          <div
                            className="h-full bg-cyan-300"
                            style={{ width: `${client.volumeLevel}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 text-[11px] text-slate-300">
                      {autoRecordMode === 'VOX' &&
                        client.isRecording &&
                        client.voxSilenceMs > 0 && (
                          <span className="text-amber-300 text-[10px]">
                            SILENCE HOLD:{' '}
                            {((10000 - client.voxSilenceMs) / 1000).toFixed(1)}s
                          </span>
                        )}
                      <span>Gain</span>
                      <span>Volume</span>
                    </div>
                  </div>

                  <div className="mt-1.5 flex items-center gap-3">
                    <div className="relative flex-1 h-14 sm:h-16 bg-[#030811] border border-cyan-500/20 rounded overflow-hidden">
                      <canvas
                        ref={(el) => {
                          canvasesRef.current.set(client.nodeId, el);
                        }}
                        width={460}
                        height={64}
                        className="w-full h-full block"
                      />
                    </div>

                    <div className="flex items-end gap-2 h-14 sm:h-16 px-1">
                      <div className="flex flex-col items-center h-full justify-end">
                        <div className="w-2.5 h-12 bg-slate-900 border border-cyan-500/25 rounded-xs overflow-hidden flex flex-col justify-end">
                          <div
                            className="w-full bg-cyan-400 transition-all duration-150"
                            style={{ height: `${gainBarPercent}%` }}
                          />
                        </div>
                      </div>

                      <div className="flex flex-col items-center h-full justify-end">
                        <div className="w-2.5 h-12 bg-slate-900 border border-cyan-500/25 rounded-xs overflow-hidden flex flex-col justify-end">
                          <div
                            className="w-full bg-cyan-300 transition-all duration-75"
                            style={{ height: `${client.volumeLevel}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-cyan-500/15">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleToggleSolo(client.nodeId)}
                        className={`px-3 py-1 text-[11px] font-semibold rounded border transition-colors cursor-pointer ${
                          isSolo
                            ? 'bg-cyan-400 text-slate-950 border-cyan-300 shadow-[0_0_10px_rgba(0,255,255,0.5)]'
                            : 'bg-[#09192c] text-cyan-200 border-cyan-500/40 hover:border-cyan-300'
                        }`}
                      >
                        SOLO
                      </button>

                      <button
                        onClick={() => handleToggleRec(client)}
                        className={`px-3 py-1 text-[11px] font-semibold rounded border flex items-center gap-1 transition-colors cursor-pointer ${
                          client.isRecording
                            ? 'bg-red-600/30 text-red-300 border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.35)]'
                            : 'bg-[#09192c] text-slate-200 border-cyan-500/40 hover:border-red-400 hover:text-red-300'
                        }`}
                      >
                        <span
                          className={`w-2 h-2 rounded-full ${
                            client.isRecording
                              ? 'bg-red-500 animate-ping'
                              : 'bg-red-500/70'
                          }`}
                        />
                        <span>REC</span>
                      </button>

                      <button
                        onClick={() => handleCycleGain(client.nodeId)}
                        className="px-3 py-1 text-[11px] font-semibold rounded border bg-[#09192c] text-cyan-200 border-cyan-500/40 hover:border-cyan-300 transition-colors cursor-pointer"
                        title="Remote Gain Control via DataChannel (SET_GAIN: 0dB to +24dB)"
                      >
                        GAIN {client.gainDb > 0 ? `+${client.gainDb}dB` : '0dB'}
                      </button>

                      <button
                        onClick={() => handleToggleRemoteMicMute(client.nodeId)}
                        className={`px-2.5 py-1 text-[11px] font-semibold rounded border flex items-center gap-1 transition-colors cursor-pointer ${
                          client.remoteMuted
                            ? 'bg-amber-600/30 text-amber-200 border-amber-400'
                            : 'bg-[#09192c] text-emerald-300 border-cyan-500/40 hover:border-emerald-400'
                        }`}
                        title="Remote Mute / Unmute Passive Client Mic via DataChannel (SET_MUTE)"
                      >
                        {client.remoteMuted ? (
                          <>
                            <MicOff className="w-3 h-3 text-amber-300" />
                            <span>MIC MUTED</span>
                          </>
                        ) : (
                          <>
                            <Mic className="w-3 h-3 text-emerald-400" />
                            <span>MIC LIVE</span>
                          </>
                        )}
                      </button>

                      <button
                        onClick={() => handleEmergencyWipeNode(client.nodeId)}
                        className="px-2.5 py-1 text-[11px] font-bold rounded border bg-red-950/80 text-red-300 border-red-500/70 hover:bg-red-600/40 flex items-center gap-1 transition-colors cursor-pointer"
                        title="Remote Emergency Wipe / Silent Self-Destruct (EMERGENCY_WIPE)"
                      >
                        <Skull className="w-3 h-3 text-red-400" />
                        <span>WIPE</span>
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
                      <div className="flex items-center gap-2 bg-[#061322] border border-cyan-500/30 rounded px-2.5 py-1">
                        <span className="text-[10px] text-cyan-300 font-semibold whitespace-nowrap">
                          DSP GAIN:
                        </span>
                        <input
                          type="range"
                          min={-12}
                          max={24}
                          step={1}
                          value={client.gainDb}
                          onChange={(e) =>
                            handleSetClientGainDb(
                              client.nodeId,
                              Number(e.target.value)
                            )
                          }
                          className="w-24 h-1.5 accent-cyan-400 bg-slate-800 rounded-lg cursor-pointer"
                          title="Real-time Master Telephony DSP GainNode Slider (-12dB s/d +24dB)"
                        />
                        <span className="text-[11px] font-mono text-cyan-200 min-w-[42px] text-right">
                          {client.gainDb > 0
                            ? `+${client.gainDb}dB`
                            : `${client.gainDb}dB`}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 text-cyan-300 font-semibold">
                        <Signal className="w-3.5 h-3.5 text-cyan-400" />
                        <div className="flex items-center gap-1">
                          <Battery className="w-4 h-4 text-cyan-400" />
                          <span>
                            /{client.battery !== null ? `${client.battery}%` : '--%'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {/* BOTTOM CONNECT NODE BAR */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              unlockAllAudioPlayback();
              if (dialInput.trim()) {
                connectToRemoteNode(dialInput);
                setDialInput('');
              }
            }}
            className="mt-auto bg-[#06101e] border border-cyan-500/40 rounded p-2.5 flex flex-wrap items-center justify-between gap-2"
          >
            <div className="flex items-center gap-2 flex-1 min-w-[200px]">
              <Radio className="w-4 h-4 text-cyan-400 shrink-0" />
              <input
                type="text"
                maxLength={4}
                value={dialInput}
                onChange={(e) => setDialInput(e.target.value.replace(/\D/g, ''))}
                placeholder="CONNECT NODE (MASUKKAN 4-DIGIT ID CLIENT)"
                className="w-full bg-[#02060d] border border-cyan-500/35 rounded px-2.5 py-1 text-xs text-cyan-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
              />
              <button
                type="submit"
                className="px-3 py-1 text-xs font-semibold bg-cyan-500/25 border border-cyan-400 text-cyan-200 rounded hover:bg-cyan-500/35 transition-colors cursor-pointer whitespace-nowrap"
              >
                LINK NODE
              </button>
              <button
                type="button"
                onClick={() => {
                  unlockAllAudioPlayback();
                  setBarcodeModalTab('SCANNER');
                  setBarcodeModalOpen(true);
                }}
                className="px-2.5 py-1 text-xs font-semibold bg-amber-500/20 border border-amber-400/60 text-amber-200 rounded hover:bg-amber-500/30 flex items-center gap-1 transition-colors cursor-pointer whitespace-nowrap"
                title="Scan Barcode HP Client"
              >
                <ScanLine className="w-3.5 h-3.5 text-amber-400" />
                <span>SCAN QR</span>
              </button>
            </div>

            <div className="text-[10px] text-slate-400 flex items-center gap-3">
              <span>{connectionBanner}</span>
            </div>
          </form>
        </div>

        {/* RIGHT COLUMN: TACTICAL LEAFLET GPS TELEMETRY MAP (REAL-TIME ONLY) */}
        <div className="lg:col-span-6 xl:col-span-7 flex flex-col order-1 lg:order-2 min-h-[360px] sm:min-h-[440px] lg:min-h-0">
          <div className="relative flex-1 w-full h-full min-h-[380px] rounded border border-cyan-500/45 bg-[#040911] overflow-hidden border-glow-cyan">
            <div className="absolute top-0 inset-x-0 z-[450] bg-gradient-to-b from-[#02060d]/95 via-[#02060d]/70 to-transparent px-3 py-1.5 flex items-center justify-between text-[10px] text-cyan-300/80 pointer-events-none">
              <div className="flex items-center gap-3">
                <span className="font-bold text-cyan-300">MGRS TACTICAL GRID</span>
                <span>CONNECTED: {connectedClients.length}/05</span>
                <span>GPS PINS: {connectedWithGps.length}</span>
              </div>
              <div className="hidden sm:flex items-center gap-3">
                <span className="text-emerald-400 font-semibold">
                  WEBRTC DATA CHANNEL: REAL-TIME ONLY
                </span>
              </div>
            </div>

            {connectedClients.length === 0 && (
              <div className="absolute inset-x-4 top-12 z-[460] pointer-events-none flex justify-center">
                <div className="bg-[#030914]/90 border border-cyan-400/50 rounded px-4 py-2.5 text-center shadow-2xl backdrop-blur-xs">
                  <div className="text-xs sm:text-sm font-bold tracking-widest text-cyan-300 text-glow-cyan">
                    STANDBY: MENUNGGU KONEKSI TELEMETRI NODE...
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {masterCoords.hasLock
                      ? `MASTER GPS CENTER: ${masterCoords.lat.toFixed(
                          5
                        )}°, ${masterCoords.lng.toFixed(5)}°`
                      : 'DEFAULT INDONESIA CENTER · MENUNGGU PAKET KOORDINAT WEBRTC'}
                  </div>
                </div>
              </div>
            )}

            {connectedWithGps.length > 0 && (
              <div className="absolute top-8 left-3 z-[450] bg-[#030914]/85 border border-cyan-500/30 rounded p-2 text-[10px] leading-relaxed text-slate-300 pointer-events-none">
                <div className="text-cyan-300 font-semibold">
                  PRIMARY: {connectedWithGps[0].label} ({connectedWithGps[0].nodeId})
                </div>
                <div>LAT: {connectedWithGps[0].lat!.toFixed(6)}°</div>
                <div>LNG: {connectedWithGps[0].lng!.toFixed(6)}°</div>
                <div>
                  ALT:{' '}
                  {connectedWithGps[0].alt !== null
                    ? `${connectedWithGps[0].alt}m`
                    : 'N/A'}
                </div>
                <div>
                  SPEED:{' '}
                  {connectedWithGps[0].speed !== null
                    ? `${connectedWithGps[0].speed}km/h`
                    : '0km/h'}
                </div>
              </div>
            )}

            <svg
              className="absolute inset-0 w-full h-full pointer-events-none z-[420]"
              preserveAspectRatio="none"
            >
              <defs>
                <pattern
                  id="sigmaGrid"
                  width="48"
                  height="48"
                  patternUnits="userSpaceOnUse"
                >
                  <path
                    d="M 48 0 L 0 0 0 48"
                    fill="none"
                    stroke="rgba(0, 255, 255, 0.08)"
                    strokeWidth="0.75"
                  />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#sigmaGrid)" />
            </svg>

            <MapContainer
              center={activeMapCenter}
              zoom={activeMapZoom}
              zoomControl={false}
              className="w-full h-full min-h-[380px] sigma-leaflet-map z-[400]"
            >
              <TileLayer
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                attribution="Tiles &copy; Esri &mdash; Source: Esri, USDA, USGS"
              />

              {polylineCoords.length > 1 && (
                <Polyline
                  positions={polylineCoords}
                  pathOptions={{
                    color: '#00FFFF',
                    weight: 1.8,
                    opacity: 0.75,
                    dashArray: '6 4',
                  }}
                />
              )}

              {connectedWithGps.map((client) => (
                <React.Fragment key={client.nodeId}>
                  <Circle
                    center={[client.lat!, client.lng!]}
                    radius={client.accuracy ?? 50}
                    pathOptions={{
                      color: '#00FFFF',
                      fillColor: '#00FFFF',
                      fillOpacity: 0.08,
                      weight: 1,
                    }}
                  />
                  <Marker
                    position={[client.lat!, client.lng!]}
                    icon={createTacticalMarkerIcon(client)}
                  />
                </React.Fragment>
              ))}

              <MapViewportController center={activeMapCenter} zoom={activeMapZoom} />
            </MapContainer>

            <div className="absolute bottom-0 inset-x-0 z-[450] bg-gradient-to-t from-[#02060d]/95 via-[#02060d]/75 to-transparent px-3 py-1 flex items-center justify-between text-[10px] text-cyan-300/70 pointer-events-none">
              <span>
                CENTER: {activeMapCenter[0].toFixed(4)}°, {activeMapCenter[1].toFixed(4)}°
              </span>
              <span>SOURCE: ESRI WORLD IMAGERY</span>
              <span>ACTIVE PEERS: {connectedClients.length}</span>
            </div>
          </div>
        </div>
      </div>

      {/* RECORDINGS LOG DRAWER */}
      {showRecordingsDrawer && (
        <div className="fixed inset-0 z-[9999] flex justify-end bg-black/75 backdrop-blur-xs">
          <div className="w-full max-w-lg bg-[#050d1a] border-l border-cyan-500/50 h-full flex flex-col justify-between p-5 text-cyan-50 font-mono-tactical shadow-2xl">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-cyan-500/30">
                <div className="flex items-center gap-2">
                  <FolderDown className="w-4 h-4 text-cyan-400" />
                  <h2 className="text-sm font-bold tracking-wider text-cyan-300">
                    RECORDINGS LOG // CAPTURED WEBM ARCHIVE
                  </h2>
                </div>
                <button
                  onClick={() => setShowRecordingsDrawer(false)}
                  className="p-1 text-slate-400 hover:text-cyan-300 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="mt-3 flex items-center justify-between bg-[#081528] border border-cyan-500/30 rounded px-3 py-2 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoDownloadClips}
                    onChange={(e) => setAutoDownloadClips(e.target.checked)}
                    className="accent-cyan-400"
                  />
                  <span className="text-slate-200">
                    Auto-download <code className="text-cyan-300">.webm</code> on capture
                    completion
                  </span>
                </label>
                <span className="text-[11px] text-cyan-400">
                  {recordings.length} FILES
                </span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto my-4 space-y-2.5 pr-1">
              {recordings.length === 0 ? (
                <div className="h-64 border border-dashed border-cyan-500/25 rounded flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-2">
                  <Disc className="w-7 h-7 text-cyan-500/50" />
                  <div className="text-xs font-semibold text-slate-300">
                    BELUM ADA REKAMAN TERSIMPAN
                  </div>
                  <p className="text-[11px] text-slate-400 max-w-xs">
                    Rekaman audio (<code className="text-cyan-300">.webm</code>) akan
                    otomatis muncul di sini setelah Node riil terhubung dan terekam melalui
                    mode <span className="text-cyan-300">{autoRecordMode}</span> atau tombol{' '}
                    <strong className="text-red-300">REC</strong>.
                  </p>
                </div>
              ) : (
                recordings.map((clip) => {
                  const isPlaying = playingClipId === clip.id;
                  return (
                    <div
                      key={clip.id}
                      className="bg-[#081629] border border-cyan-500/35 rounded p-3 space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-xs font-bold text-cyan-300 break-all">
                          {clip.filename}
                        </div>
                        <span className="text-[10px] text-slate-400 shrink-0">
                          {clip.trigger} · {clip.durationSec}s ·{' '}
                          {Math.max(1, Math.round(clip.sizeBytes / 1024))}KB
                        </span>
                      </div>

                      <div className="flex items-center justify-between pt-1">
                        <span className="text-[11px] text-slate-400">
                          {clip.nodeLabel} ({clip.nodeId}) ·{' '}
                          {clip.createdAt.toLocaleTimeString()}
                        </span>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => {
                              if (!audioPlayerRef.current) return;
                              if (isPlaying) {
                                audioPlayerRef.current.pause();
                                setPlayingClipId(null);
                              } else {
                                audioPlayerRef.current.src = clip.url;
                                audioPlayerRef.current.play().catch(() => {});
                                setPlayingClipId(clip.id);
                              }
                            }}
                            className="flex items-center gap-1 px-2.5 py-1 text-[11px] bg-cyan-500/20 border border-cyan-400/50 text-cyan-200 rounded hover:bg-cyan-500/30 cursor-pointer"
                          >
                            {isPlaying ? (
                              <>
                                <Pause className="w-3 h-3" />
                                <span>PAUSE</span>
                              </>
                            ) : (
                              <>
                                <Play className="w-3 h-3" />
                                <span>PLAY</span>
                              </>
                            )}
                          </button>

                          <a
                            href={clip.url}
                            download={clip.filename}
                            className="flex items-center gap-1 px-2.5 py-1 text-[11px] bg-emerald-500/20 border border-emerald-400/50 text-emerald-200 rounded hover:bg-emerald-500/30"
                          >
                            <Download className="w-3 h-3" />
                            <span>.WEBM</span>
                          </a>

                          <button
                            onClick={() => {
                              URL.revokeObjectURL(clip.url);
                              setRecordings((prev) =>
                                prev.filter((item) => item.id !== clip.id)
                              );
                            }}
                            className="p-1 text-slate-400 hover:text-red-400 cursor-pointer"
                            title="Delete capture"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="pt-3 border-t border-cyan-500/20 flex items-center justify-between text-xs">
              <span className="text-slate-400">
                FORMAT: <code className="text-cyan-300">WEBM / OPUS</code>
              </span>
              <button
                onClick={() => setShowRecordingsDrawer(false)}
                className="px-4 py-1.5 bg-cyan-500/20 border border-cyan-400 text-cyan-200 rounded font-semibold cursor-pointer"
              >
                CLOSE LOG
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Master;
