/**
 * ============================================================================
 * S.I.G.M.A. WebRTC Mobile Audio Engine (Standalone Vanilla JS Module)
 * Kompatibel untuk Samsung Galaxy A26 5G (Android Chrome & Samsung Internet)
 * ============================================================================
 * Solusi Utama:
 * 1. setupNegotiation(peerConnection, options)  -> SDP Renegotiation Handler (onnegotiationneeded)
 * 2. handleIncomingAudio(event, options)        -> Dynamic <audio autoplay playsinline> DOM Injection
 * 3. unlockAudioAutoplay(audioElement, options) -> Samsung/Chrome Autoplay Unlocker + Fallback Button
 */

const injectedAudioRegistry = new Map();
let fallbackBannerEl = null;

/**
 * 1. SDP RENEGOTIATION HANDLER
 * Mendengarkan event `onnegotiationneeded` pada RTCPeerConnection.
 * Jika stream mikrofon ditambahkan belakangan setelah DataChannel (GPS) terbuka,
 * fungsi ini otomatis memicu pembuatan `createOffer` dan sinkronisasi SDP baru.
 *
 * @param {RTCPeerConnection} peerConnection
 * @param {Object} [options]
 * @param {Function} [options.sendSignal] - Callback pengirim sinyal SDP (misal via WebSocket/DataChannel)
 * @param {RTCDataChannel|Object} [options.dataChannel] - DataChannel yang sudah terbuka untuk kirim SDP langsung
 * @param {string} [options.nodeId] - ID Node pengirim
 */
export function setupNegotiation(peerConnection, options = {}) {
  let isNegotiating = false;
  let queuedRenegotiation = false;

  const dispatchSignal = (payload) => {
    if (typeof options.sendSignal === 'function') {
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
          if (options.onError) options.onError(err);
        }
      }
    }
  };

  const performRenegotiation = async () => {
    if (!peerConnection || peerConnection.connectionState === 'closed') return;

    // Cegah kondisi Glare apabila signalingState belum 'stable'
    if (isNegotiating || peerConnection.signalingState !== 'stable') {
      queuedRenegotiation = true;
      return;
    }

    try {
      isNegotiating = true;

      // Pastikan transceiver audio memiliki direction 'sendrecv'
      if (typeof peerConnection.getTransceivers === 'function') {
        peerConnection.getTransceivers().forEach((transceiver) => {
          const isAudio =
            (transceiver.sender && transceiver.sender.track && transceiver.sender.track.kind === 'audio') ||
            (transceiver.receiver && transceiver.receiver.track && transceiver.receiver.track.kind === 'audio');
          if (isAudio && (transceiver.direction === 'inactive' || transceiver.direction === 'recvonly')) {
            try {
              transceiver.direction = 'sendrecv';
            } catch (_) {}
          }
        });
      }

      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
      });

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
      }
    } catch (err) {
      if (options.onError) options.onError(err);
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
      performRenegotiation().catch((err) => {
        if (options.onError) options.onError(err);
      });
    };

    const prevSignalingChange = peerConnection.onsignalingstatechange;
    peerConnection.onsignalingstatechange = (ev) => {
      if (typeof prevSignalingChange === 'function') {
        prevSignalingChange.call(peerConnection, ev);
      }
      if (peerConnection.signalingState === 'stable' && queuedRenegotiation) {
        queuedRenegotiation = false;
        performRenegotiation().catch(() => {});
      }
    };
  }

  /**
   * Memproses SDP Offer/Answer hasil renegosiasi dari peer lawan.
   */
  const handleRemoteSignal = async (signal) => {
    if (!peerConnection || !signal || !signal.type) return;

    try {
      if (signal.type === 'SIGMA_SDP_RENEGOTIATE_OFFER' && signal.sdp) {
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
        }
      } else if (signal.type === 'SIGMA_SDP_RENEGOTIATE_ANSWER' && signal.sdp) {
        if (peerConnection.signalingState === 'have-local-offer') {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        }
      } else if (signal.type === 'SIGMA_ICE_CANDIDATE' && signal.candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (err) {
      if (options.onError) options.onError(err);
    }
  };

  return {
    handleRemoteSignal,
    triggerManualRenegotiation: performRenegotiation,
    cleanup: () => {
      if (peerConnection) peerConnection.onnegotiationneeded = null;
    },
  };
}

/**
 * 2. AUTO-PLAY & AUDIO ELEMENT INJECTION
 * Dipasang pada `peerConnection.ontrack = (event) => handleIncomingAudio(event)`.
 * Secara dinamis membuat elemen `<audio autoplay playsinline>` (TANPA atribut muted)
 * di dalam DOM, lalu memasukkan `event.streams[0]` ke dalam `srcObject`.
 *
 * @param {RTCTrackEvent} event
 * @param {Object} [options]
 * @returns {HTMLAudioElement|null}
 */
export function handleIncomingAudio(event, options = {}) {
  const incomingStream =
    event.streams && event.streams[0]
      ? event.streams[0]
      : event.track
      ? new MediaStream([event.track])
      : null;

  if (!incomingStream) return null;

  // Pastikan semua audio track aktif (enabled = true)
  incomingStream.getAudioTracks().forEach((track) => {
    track.enabled = true;
  });

  const elementKey = options.audioId || incomingStream.id || 'default-peer';
  const domId = `sigma-webrtc-audio-${elementKey}`;

  let audioEl = injectedAudioRegistry.get(elementKey) || document.getElementById(domId);

  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = domId;

    // Wajib <audio autoplay playsinline> TANPA atribut muted
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.controls = false;
    audioEl.setAttribute('autoplay', '');
    audioEl.setAttribute('playsinline', '');
    audioEl.setAttribute('webkit-playsinline', '');

    audioEl.muted = false;
    audioEl.removeAttribute('muted');
    audioEl.volume = 1.0;

    // Offscreen 1x1px (hindari display:none agar Samsung Android tidak men-suspend decoder hardware)
    audioEl.style.position = 'fixed';
    audioEl.style.bottom = '0px';
    audioEl.style.right = '0px';
    audioEl.style.width = '1px';
    audioEl.style.height = '1px';
    audioEl.style.opacity = '0.01';
    audioEl.style.pointerEvents = 'none';
    audioEl.style.zIndex = '-1';

    const container = options.container || document.body;
    container.appendChild(audioEl);
    injectedAudioRegistry.set(elementKey, audioEl);
  } else {
    audioEl.muted = false;
    audioEl.removeAttribute('muted');
    audioEl.volume = 1.0;
  }

  if (audioEl.srcObject !== incomingStream) {
    audioEl.srcObject = incomingStream;
  }

  if (typeof options.onStreamAttached === 'function') {
    options.onStreamAttached(incomingStream, audioEl);
  }

  // Tangani event onunmute pada track ketika paket RTP audio pertama mendarat
  incomingStream.getAudioTracks().forEach((track) => {
    track.onunmute = () => {
      if (audioEl) {
        audioEl.muted = false;
        unlockAudioAutoplay(audioEl, options);
      }
    };
  });

  unlockAudioAutoplay(audioEl, options);
  return audioEl;
}

/**
 * 3. AUTOPLAY UNLOCKER (SAMSUNG / CHROME FIX)
 * Dipanggil pada interaksi pertama pengguna (misal klik tombol "Terima Koneksi" / "Link Node").
 * Memastikan `audioElement.play()` dieksekusi dengan benar, me-resume AudioContext,
 * dan menangkap error `NotAllowedError` serta memunculkan tombol fallback "Tap to Unmute".
 *
 * @param {HTMLAudioElement} [audioElement]
 * @param {Object} [options]
 * @returns {Promise<boolean>}
 */
export function unlockAudioAutoplay(audioElement, options = {}) {
  if (options.audioContext && options.audioContext.state === 'suspended') {
    options.audioContext.resume().catch(() => {});
  }

  const targets = [];
  if (audioElement) targets.push(audioElement);
  injectedAudioRegistry.forEach((el) => {
    if (!targets.includes(el)) targets.push(el);
  });

  if (targets.length === 0) {
    hideTapToUnmuteFallback();
    return Promise.resolve(true);
  }

  const playPromises = targets.map(async (el) => {
    try {
      el.muted = false;
      el.removeAttribute('muted');
      if (el.volume === 0) el.volume = 1.0;

      const playPromise = el.play();
      if (playPromise !== undefined) {
        await playPromise;
      }

      if (typeof options.onUnlocked === 'function') {
        options.onUnlocked(el);
      }
      return true;
    } catch (err) {
      // Tangkap NotAllowedError pada Samsung Internet / Chrome Android
      if (err && (err.name === 'NotAllowedError' || String(err).includes('NotAllowedError'))) {
        if (typeof options.onBlocked === 'function') {
          options.onBlocked(el, err);
        }
        showTapToUnmuteFallback(el, options);
      } else {
        if (typeof options.onBlocked === 'function') {
          options.onBlocked(el, err);
        }
        showTapToUnmuteFallback(el, options);
      }
      return false;
    }
  });

  return Promise.all(playPromises).then((results) => {
    const allOk = results.every(Boolean);
    if (allOk) hideTapToUnmuteFallback();
    return allOk;
  });
}

function showTapToUnmuteFallback(audioElement, options = {}) {
  if (typeof document === 'undefined') return;

  if (!fallbackBannerEl) {
    fallbackBannerEl = document.createElement('div');
    fallbackBannerEl.id = 'sigma-autoplay-fallback-banner';
    Object.assign(fallbackBannerEl.style, {
      position: 'fixed',
      bottom: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '99999',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '10px 16px',
      backgroundColor: 'rgba(4, 13, 26, 0.96)',
      border: '1px solid #f59e0b',
      borderRadius: '6px',
      boxShadow: '0 0 24px rgba(245, 158, 11, 0.35)',
      fontFamily: "'JetBrains Mono', monospace",
      color: '#fef3c7',
      fontSize: '12px',
    });

    const textSpan = document.createElement('span');
    textSpan.textContent = 'Browser memblokir Autoplay Audio (NotAllowedError).';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = options.fallbackButtonText || '🔊 TAP TO UNMUTE';
    Object.assign(btn.style, {
      padding: '6px 12px',
      backgroundColor: '#f59e0b',
      color: '#020617',
      fontWeight: '700',
      border: 'none',
      borderRadius: '4px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    });

    const handleTap = (e) => {
      e.stopPropagation();
      unlockAudioAutoplay(audioElement, options);
    };

    btn.addEventListener('click', handleTap);
    btn.addEventListener('touchend', handleTap);

    fallbackBannerEl.appendChild(textSpan);
    fallbackBannerEl.appendChild(btn);
    document.body.appendChild(fallbackBannerEl);
  }
}

function hideTapToUnmuteFallback() {
  if (fallbackBannerEl && fallbackBannerEl.parentNode) {
    fallbackBannerEl.parentNode.removeChild(fallbackBannerEl);
  }
  fallbackBannerEl = null;
}

if (typeof window !== 'undefined') {
  window.SigmaWebRTCAudio = {
    setupNegotiation,
    handleIncomingAudio,
    unlockAudioAutoplay,
  };
}
