/**
 * ============================================================================
 * S.I.G.M.A. WebRTC Mobile Audio Engine (Samsung Galaxy A26 5G / Android Chrome Fix)
 * Standalone & Modular Vanilla JS / TS WebRTC Audio Handler
 * ============================================================================
 * Fokus Solusi:
 * 1. setupNegotiation(peerConnection, options)  -> SDP Renegotiation Handler (onnegotiationneeded)
 * 2. handleIncomingAudio(event, options)        -> Dynamic <audio autoplay playsinline> DOM Injection
 * 3. unlockAudioAutoplay(audioElement, options) -> Samsung/Chrome Autoplay Unlocker + Fallback UI
 */

export interface SignalingEnvelope {
  type:
    | 'SIGMA_SDP_RENEGOTIATE_OFFER'
    | 'SIGMA_SDP_RENEGOTIATE_ANSWER'
    | 'SIGMA_ICE_CANDIDATE';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  nodeId?: string;
}

export interface SetupNegotiationOptions {
  /**
   * Callback untuk mengirim SDP Offer/Answer baru ke peer lawan
   * (bisa melalui WebSocket Signaling atau DataChannel yang sudah terbuka).
   */
  sendSignal?: (payload: SignalingEnvelope) => void;
  /**
   * Opsional: DataChannel atau PeerJS DataConnection yang sudah terbuka
   * untuk mengirim paket SDP renegotiation secara langsung.
   */
  dataChannel?: {
    send: (data: unknown) => void;
    readyState?: RTCDataChannelState;
    open?: boolean;
  } | null;
  nodeId?: string;
  onStatusChange?: (status: string) => void;
  onError?: (error: unknown) => void;
}

export interface HandleIncomingAudioOptions {
  /** ID unik untuk elemen audio (misal nodeId "7734") */
  audioId?: string;
  /** Container DOM tempat menyuntikkan elemen <audio> (default: document.body) */
  container?: HTMLElement;
  /** Callback saat MediaStream audio berhasil diterima dan disambungkan */
  onStreamAttached?: (stream: MediaStream, audioElement: HTMLAudioElement) => void;
  /** Callback jika browser memblokir autoplay (NotAllowedError) */
  onAutoplayBlocked?: (audioElement: HTMLAudioElement, error: Error) => void;
  /** Callback saat audio berhasil diputar */
  onAutoplaySuccess?: (audioElement: HTMLAudioElement) => void;
}

export interface UnlockAudioOptions {
  /** AudioContext opsional yang ikut di-resume saat interaksi pengguna */
  audioContext?: AudioContext | null;
  /** Teks kustom untuk tombol fallback jika terkena NotAllowedError */
  fallbackButtonText?: string;
  /** Callback saat audio berhasil di-unlock */
  onUnlocked?: (audioElement: HTMLAudioElement) => void;
  /** Callback saat terkena blokir NotAllowedError */
  onBlocked?: (audioElement: HTMLAudioElement, error: Error) => void;
}

// Registry internal untuk melacak semua elemen <audio> yang diinjeksikan secara dinamis
const injectedAudioRegistry = new Map<string, HTMLAudioElement>();
let fallbackBannerEl: HTMLDivElement | null = null;

/**
 * ============================================================================
 * 1. SDP RENEGOTIATION HANDLER
 * ============================================================================
 * Mendengarkan event `onnegotiationneeded` pada RTCPeerConnection.
 * Jika track mikrofon ditambahkan belakangan setelah DataChannel (GPS) terbuka,
 * fungsi ini otomatis membuat Offer baru (`createOffer`), mengatur `setLocalDescription`,
 * dan mengirimkan SDP baru ke peer lawan untuk disinkronkan.
 */
export function setupNegotiation(
  peerConnection: RTCPeerConnection | null | undefined,
  options: SetupNegotiationOptions = {}
): {
  handleRemoteSignal: (signal: SignalingEnvelope) => Promise<void>;
  triggerManualRenegotiation: () => Promise<void>;
  cleanup: () => void;
} {
  let isNegotiating = false;
  let queuedRenegotiation = false;

  const dispatchSignal = (payload: SignalingEnvelope) => {
    if (options.sendSignal) {
      options.sendSignal(payload);
      return;
    }
    const dc = options.dataChannel;
    if (dc) {
      const isOpen = dc.readyState === 'open' || dc.open === true;
      if (isOpen) {
        try {
          if (typeof dc.readyState === 'string') {
            dc.send(JSON.stringify(payload));
          } else {
            dc.send(payload);
          }
        } catch (err) {
          options.onError?.(err);
        }
      }
    }
  };

  const performRenegotiation = async () => {
    if (!peerConnection || peerConnection. connectionState === 'closed') return;

    // Hindari tabrakan state SDP (glare) jika koneksi belum 'stable'
    if (isNegotiating || peerConnection.signalingState !== 'stable') {
      queuedRenegotiation = true;
      return;
    }

    try {
      isNegotiating = true;
      options.onStatusChange?.('SDP_RENEGOTIATION_STARTED');

      // Pastikan transceiver audio diset ke 'sendrecv' atau 'sendonly' agar Samsung Chrome tidak membisukan arah aliran
      if (typeof peerConnection.getTransceivers === 'function') {
        peerConnection.getTransceivers().forEach((transceiver) => {
          if (
            transceiver.sender.track?.kind === 'audio' ||
            transceiver.receiver.track?.kind === 'audio'
          ) {
            if (transceiver.direction === 'inactive' || transceiver.direction === 'recvonly') {
              try {
                transceiver.direction = 'sendrecv';
              } catch {}
            }
          }
        });
      }

      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
      });

      // Jika state berubah saat menunggu createOffer, batalkan
      if (peerConnection.signalingState !== 'stable') {
        queuedRenegotiation = true;
        return;
      }

      await peerConnection.setLocalDescription(offer);

      if (peerConnection.localDescription) {
        dispatchSignal({
          type: 'SIGMA_SDP_RENEGOTIATE_OFFER',
          sdp: {
            type: peerConnection.localDescription.type,
            sdp: peerConnection.localDescription.sdp,
          },
          nodeId: options.nodeId,
        });
        options.onStatusChange?.('SDP_OFFER_DISPATCHED');
      }
    } catch (err) {
      options.onError?.(err);
    } finally {
      isNegotiating = false;
      if (queuedRenegotiation && peerConnection.signalingState === 'stable') {
        queuedRenegotiation = false;
        setTimeout(() => {
          performRenegotiation().catch(() => {});
        }, 120);
      }
    }
  };

  if (peerConnection) {
    peerConnection.onnegotiationneeded = () => {
      performRenegotiation().catch((err) => options.onError?.(err));
    };

    const prevSignalingStateChange = peerConnection.onsignalingstatechange;
    peerConnection.onsignalingstatechange = (ev) => {
      if (typeof prevSignalingStateChange === 'function') {
        prevSignalingStateChange.call(peerConnection, ev);
      }
      if (peerConnection.signalingState === 'stable' && queuedRenegotiation) {
        queuedRenegotiation = false;
        performRenegotiation().catch((err) => options.onError?.(err));
      }
    };
  }

  /**
   * Fungsi pendamping untuk memproses paket SDP Offer/Answer yang diterima dari peer lawan.
   */
  const handleRemoteSignal = async (signal: SignalingEnvelope) => {
    if (!peerConnection || !signal || !signal.type) return;

    try {
      if (signal.type === 'SIGMA_SDP_RENEGOTIATE_OFFER' && signal.sdp) {
        // Pastikan semua transceiver audio siap menerima stream
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        if (peerConnection.localDescription) {
          dispatchSignal({
            type: 'SIGMA_SDP_RENEGOTIATE_ANSWER',
            sdp: {
              type: peerConnection.localDescription.type,
              sdp: peerConnection.localDescription.sdp,
            },
            nodeId: options.nodeId,
          });
          options.onStatusChange?.('SDP_ANSWER_DISPATCHED');
        }
      } else if (signal.type === 'SIGMA_SDP_RENEGOTIATE_ANSWER' && signal.sdp) {
        if (peerConnection.signalingState === 'have-local-offer') {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          options.onStatusChange?.('SDP_RENEGOTIATION_COMPLETED');
        }
      } else if (signal.type === 'SIGMA_ICE_CANDIDATE' && signal.candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (err) {
      options.onError?.(err);
    }
  };

  const cleanup = () => {
    if (peerConnection) {
      peerConnection.onnegotiationneeded = null;
    }
  };

  return {
    handleRemoteSignal,
    triggerManualRenegotiation: performRenegotiation,
    cleanup,
  };
}

/**
 * ============================================================================
 * 2. AUTO-PLAY & AUDIO ELEMENT INJECTION
 * ============================================================================
 * Dipasang pada `peerConnection.ontrack = (event) => handleIncomingAudio(event)`.
 * Membuat elemen `<audio autoplay playsinline>` secara dinamis (TANPA atribut muted)
 * di dalam DOM, lalu memasukkan `event.streams[0]` ke dalam `srcObject`.
 *
 * Catatan penting untuk Samsung Galaxy A26 5G (Android Chrome / Samsung Internet):
 * Jangan gunakan `display: none` pada elemen `<audio>` WebRTC karena hardware audio
 * scheduler di Android sering menghentikan decoding untuk elemen yang disembunyikan penuh.
 * Sebagai gantinya, gunakan ukuran 1x1px offscreen dengan opacity minimal.
 */
// Registry internal untuk melacak MediaStream gabungan per clientId agar multi-transceiver tidak saling menimpa
const clientCompositeStreams = new Map<string, MediaStream>();

export function handleIncomingAudio(
  event: RTCTrackEvent | { streams?: readonly MediaStream[]; track?: MediaStreamTrack },
  options: HandleIncomingAudioOptions = {}
): HTMLAudioElement | null {
  // Ekstrak MediaStream dari event.streams[0] atau buat dari event.track
  const rawIncomingStream =
    event.streams && event.streams[0]
      ? event.streams[0]
      : event.track
      ? new MediaStream([event.track])
      : null;

  if (!rawIncomingStream && !event.track) return null;

  const clientId =
    options.audioId ||
    rawIncomingStream?.id ||
    event.track?.id ||
    `peer-${Date.now()}`;
  const domId = `audio-client-${clientId}`;

  // Kumpulkan semua audio track aktif untuk clientId ini dan buat MediaStream baru
  // agar Chromium / Samsung Internet langsung me-refresh decoder <audio>.srcObject
  const previousStream = clientCompositeStreams.get(clientId);
  const trackMap = new Map<string, MediaStreamTrack>();

  if (previousStream) {
    previousStream.getAudioTracks().forEach((t) => {
      if (t.readyState !== 'ended') {
        t.enabled = true;
        trackMap.set(t.id, t);
      }
    });
  }
  if (rawIncomingStream) {
    rawIncomingStream.getAudioTracks().forEach((t) => {
      t.enabled = true;
      trackMap.set(t.id, t);
    });
  }
  if (event.track && event.track.kind === 'audio') {
    event.track.enabled = true;
    trackMap.set(event.track.id, event.track);
  }

  const activeStream = new MediaStream(Array.from(trackMap.values()));
  clientCompositeStreams.set(clientId, activeStream);

  // Cari atau buat elemen <audio autoplay playsinline> yang BARU dan UNIK khusus untuk clientId ini
  let audioEl =
    injectedAudioRegistry.get(clientId) ||
    (document.getElementById(domId) as HTMLAudioElement | null);

  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = domId;
    audioEl.dataset.clientId = clientId;

    // Pasang atribut autoplay dan playsinline secara eksplisit (TANPA atribut muted)
    audioEl.autoplay = true;
    (audioEl as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    audioEl.controls = false;
    audioEl.setAttribute('autoplay', '');
    audioEl.setAttribute('playsinline', '');
    audioEl.setAttribute('webkit-playsinline', '');

    // Pastikan TIDAK ada atribut muted agar decoder WebRTC Chrome/Android tetap berjalan aktif,
    // namun set volume = 0 agar suara mentah tidak bocor dan 100% suara keluar dari Telephony-Grade DSP Pipeline
    audioEl.muted = false;
    audioEl.removeAttribute('muted');
    audioEl.volume = 0;

    // Styling offscreen 1x1px (bukan display:none) agar tidak di-suspend oleh Android Chrome / Samsung OneUI
    audioEl.style.position = 'fixed';
    audioEl.style.bottom = '0px';
    audioEl.style.right = '0px';
    audioEl.style.width = '1px';
    audioEl.style.height = '1px';
    audioEl.style.opacity = '0.01';
    audioEl.style.pointerEvents = 'none';
    audioEl.style.zIndex = '-1';

    const targetContainer =
      options.container ||
      document.getElementById('master-multi-audio-stage') ||
      document.body;
    targetContainer.appendChild(audioEl);
    injectedAudioRegistry.set(clientId, audioEl);
  } else {
    audioEl.muted = false;
    audioEl.removeAttribute('muted');
    audioEl.volume = 0;
  }

  // Pasang stream unik milik Klien tersebut ke srcObject
  if (audioEl.srcObject !== activeStream) {
    audioEl.srcObject = activeStream;
  }

  options.onStreamAttached?.(activeStream, audioEl);

  // Jika track sempat muted di level jaringan lalu unmute saat paket RTP pertama tiba (umum di Samsung 5G)
  activeStream.getAudioTracks().forEach((track) => {
    track.onunmute = () => {
      if (audioEl) {
        audioEl.muted = false;
        if (audioEl.srcObject !== activeStream) {
          audioEl.srcObject = activeStream;
        }
        options.onStreamAttached?.(activeStream, audioEl);
        unlockAudioAutoplay(audioEl, {
          onUnlocked: options.onAutoplaySuccess,
          onBlocked: options.onAutoplayBlocked,
        });
      }
    };
  });

  // Langsung coba putar dengan Autoplay Unlocker
  unlockAudioAutoplay(audioEl, {
    onUnlocked: options.onAutoplaySuccess,
    onBlocked: options.onAutoplayBlocked,
  });

  return audioEl;
}

/**
 * ============================================================================
 * 3. AUTOPLAY UNLOCKER (SAMSUNG / CHROME MOBILE FIX)
 * ============================================================================
 * Memastikan `audioElement.play()` dieksekusi dengan benar, me-resume AudioContext
 * jika tertahan (`suspended`), serta menangkap error `NotAllowedError` apabila
 * browser memblokir pemutaran otomatis dan otomatis menampilkan tombol fallback
 * interaktif "Tap to Unmute / Aktifkan Audio".
 */
export function unlockAudioAutoplay(
  audioElement?: HTMLAudioElement | null,
  options: UnlockAudioOptions = {}
): Promise<boolean> {
  // 1. Resume Web Audio API AudioContext bila diberikan
  if (options.audioContext && options.audioContext.state === 'suspended') {
    options.audioContext.resume().catch(() => {});
  }

  // Kumpulkan semua elemen audio yang perlu di-unlock (baik yang dikirim via argumen maupun yang ada di registry)
  const targets: HTMLAudioElement[] = [];
  if (audioElement) {
    targets.push(audioElement);
  }
  injectedAudioRegistry.forEach((el) => {
    if (!targets.includes(el)) {
      targets.push(el);
    }
  });

  if (targets.length === 0) {
    hideTapToUnmuteFallback();
    return Promise.resolve(true);
  }

  const playAttempts = targets.map(async (el) => {
    try {
      // Pastikan atribut muted bersih sebelum play() agar decoder WebRTC aktif
      el.muted = false;
      el.removeAttribute('muted');

      const playPromise = el.play();
      if (playPromise !== undefined) {
        await playPromise;
      }

      options.onUnlocked?.(el);
      return true;
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      const isNotAllowed =
        errorObj.name === 'NotAllowedError' ||
        errorObj.message.toLowerCase().includes('notallowed') ||
        errorObj.message.toLowerCase().includes('user didn\'t interact') ||
        errorObj.message.toLowerCase().includes('gesture');

      if (isNotAllowed) {
        options.onBlocked?.(el, errorObj);
        showTapToUnmuteFallback(el, options);
      } else {
        options.onBlocked?.(el, errorObj);
        showTapToUnmuteFallback(el, options);
      }
      return false;
    }
  });

  return Promise.all(playAttempts).then((results) => {
    const allSucceeded = results.every(Boolean);
    if (allSucceeded) {
      hideTapToUnmuteFallback();
    }
    return allSucceeded;
  });
}

/**
 * Menampilkan tombol fallback mengambang "TAP TO UNMUTE / AKTIFKAN AUDIO"
 * secara otomatis apabila browser Samsung / Chrome melempar `NotAllowedError`.
 */
function showTapToUnmuteFallback(
  audioElement: HTMLAudioElement,
  options: UnlockAudioOptions
): void {
  if (typeof document === 'undefined') return;

  if (!fallbackBannerEl) {
    fallbackBannerEl = document.createElement('div');
    fallbackBannerEl.id = 'sigma-autoplay-fallback-banner';
    fallbackBannerEl.style.position = 'fixed';
    fallbackBannerEl.style.bottom = '20px';
    fallbackBannerEl.style.left = '50%';
    fallbackBannerEl.style.transform = 'translateX(-50%)';
    fallbackBannerEl.style.zIndex = '99999';
    fallbackBannerEl.style.display = 'flex';
    fallbackBannerEl.style.alignItems = 'center';
    fallbackBannerEl.style.gap = '12px';
    fallbackBannerEl.style.padding = '10px 16px';
    fallbackBannerEl.style.backgroundColor = 'rgba(4, 13, 26, 0.96)';
    fallbackBannerEl.style.border = '1px solid #f59e0b';
    fallbackBannerEl.style.borderRadius = '6px';
    fallbackBannerEl.style.boxShadow = '0 0 24px rgba(245, 158, 11, 0.35)';
    fallbackBannerEl.style.fontFamily = "'JetBrains Mono', monospace";
    fallbackBannerEl.style.color = '#fef3c7';
    fallbackBannerEl.style.fontSize = '12px';

    const labelSpan = document.createElement('span');
    labelSpan.textContent = 'Audio WebRTC ditahan oleh browser (Autoplay Policy).';

    const unlockBtn = document.createElement('button');
    unlockBtn.type = 'button';
    unlockBtn.textContent =
      options.fallbackButtonText || '🔊 TAP TO UNMUTE / AKTIFKAN AUDIO';
    unlockBtn.style.padding = '6px 12px';
    unlockBtn.style.backgroundColor = '#f59e0b';
    unlockBtn.style.color = '#020617';
    unlockBtn.style.fontWeight = '700';
    unlockBtn.style.border = 'none';
    unlockBtn.style.borderRadius = '4px';
    unlockBtn.style.cursor = 'pointer';
    unlockBtn.style.whiteSpace = 'nowrap';

    const triggerUnlock = (e: Event) => {
      e.stopPropagation();
      unlockAudioAutoplay(audioElement, options);
    };

    unlockBtn.addEventListener('click', triggerUnlock);
    unlockBtn.addEventListener('touchend', triggerUnlock);

    fallbackBannerEl.appendChild(labelSpan);
    fallbackBannerEl.appendChild(unlockBtn);
    document.body.appendChild(fallbackBannerEl);
  }
}

function hideTapToUnmuteFallback(): void {
  if (fallbackBannerEl && fallbackBannerEl.parentNode) {
    fallbackBannerEl.parentNode.removeChild(fallbackBannerEl);
  }
  fallbackBannerEl = null;
}

/**
 * Membersihkan elemen <audio> yang diinjeksikan ketika Node terputus.
 */
export function removeInjectedAudioElement(audioId: string): void {
  clientCompositeStreams.delete(audioId);
  const el = injectedAudioRegistry.get(audioId);
  if (el) {
    try {
      el.pause();
      el.srcObject = null;
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    } catch {}
    injectedAudioRegistry.delete(audioId);
  }
  if (injectedAudioRegistry.size === 0) {
    hideTapToUnmuteFallback();
  }
}
