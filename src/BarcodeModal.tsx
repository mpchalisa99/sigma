import React, { useEffect, useRef, useState, useCallback } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  QrCode,
  ScanLine,
  Share2,
  Download,
  Copy,
  Check,
  Smartphone,
  Radio,
  Camera,
  Upload,
  X,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import { usePWAInstall } from './usePWAInstall';

export interface BarcodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'CLIENT_JOIN' | 'SHARE_APK' | 'SCANNER';
  defaultNodeId?: string;
  masterPeerId?: string;
  onScanNodeId?: (nodeId: string, masterId?: string) => void;
}

/**
 * Generates deterministic 1D barcode bar widths for a given string
 * so the tactical card displays both a scannable 2D QR code and a 1D linear barcode.
 */
function generateLinearBars(text: string): number[] {
  const bars: number[] = [2, 1, 1, 2, 3, 1];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bars.push(((code >> 0) & 3) + 1);
    bars.push(((code >> 2) & 3) + 1);
    bars.push(((code >> 4) & 3) + 1);
    bars.push(((code >> 6) & 1) + 1);
  }
  bars.push(3, 1, 1, 2, 1, 2);
  return bars;
}

export const BarcodeModal: React.FC<BarcodeModalProps> = ({
  isOpen,
  onClose,
  initialTab = 'CLIENT_JOIN',
  defaultNodeId,
  masterPeerId,
  onScanNodeId,
}) => {
  const [activeTab, setActiveTab] = useState<'CLIENT_JOIN' | 'SHARE_APK' | 'SCANNER'>(
    initialTab
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string>(() =>
    defaultNodeId && /^\d{4}$/.test(defaultNodeId)
      ? defaultNodeId
      : String(Math.floor(1000 + Math.random() * 9000))
  );
  const [apkTargetRole, setApkTargetRole] = useState<'NODE_CLIENT' | 'FULL_SUITE'>(
    'NODE_CLIENT'
  );
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const { isInstallable, install } = usePWAInstall();

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
      if (defaultNodeId && /^\d{4}$/.test(defaultNodeId)) {
        setSelectedNodeId(defaultNodeId);
      }
    }
  }, [isOpen, initialTab, defaultNodeId]);

  const baseOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  const clientJoinUrl = `${baseOrigin}/?mode=node&id=${encodeURIComponent(
    selectedNodeId
  )}${masterPeerId ? `&master=${encodeURIComponent(masterPeerId)}` : ''}`;

  const shareApkUrl =
    apkTargetRole === 'NODE_CLIENT'
      ? `${baseOrigin}/?mode=node&id=${encodeURIComponent(selectedNodeId)}&install=apk${
          masterPeerId ? `&master=${encodeURIComponent(masterPeerId)}` : ''
        }`
      : `${baseOrigin}/?install=apk`;

  const activeUrl = activeTab === 'SHARE_APK' ? shareApkUrl : clientJoinUrl;
  const linearBarcodeText =
    activeTab === 'SHARE_APK'
      ? `SIGMA-APK-${apkTargetRole === 'NODE_CLIENT' ? selectedNodeId : 'FULL'}`
      : `SIGMA-NODE-${selectedNodeId}`;

  useEffect(() => {
    if (!isOpen || activeTab === 'SCANNER') return;
    let mounted = true;
    QRCode.toDataURL(activeUrl, {
      width: 320,
      margin: 2,
      color: {
        dark: '#00FFFF',
        light: '#030812',
      },
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (mounted) setQrDataUrl(url);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [isOpen, activeTab, activeUrl]);

  const handleDecodedPayload = useCallback(
    (rawText: string) => {
      const text = rawText.trim();
      setScanResult(text);

      const directMatch = text.match(/(?:SIGMA-NODE-|^)(\d{4})$/i);
      if (directMatch && onScanNodeId) {
        onScanNodeId(directMatch[1]);
        onClose();
        return;
      }

      try {
        const parsed = new URL(text);
        const idParam = parsed.searchParams.get('id');
        const masterParam = parsed.searchParams.get('master') || undefined;
        if (idParam && /^\d{4}$/.test(idParam)) {
          if (onScanNodeId) {
            onScanNodeId(idParam, masterParam);
            onClose();
            return;
          } else {
            window.location.href = parsed.toString();
            return;
          }
        }
      } catch {}

      const anyFourDigits = text.match(/\b(\d{4})\b/);
      if (anyFourDigits && onScanNodeId) {
        onScanNodeId(anyFourDigits[1]);
        onClose();
      }
    },
    [onClose, onScanNodeId]
  );

  const stopCamera = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    }
    setCameraActive(false);
  }, []);

  useEffect(() => {
    if (!isOpen || activeTab !== 'SCANNER') {
      stopCamera();
      return;
    }

    let cancelled = false;
    setScanError(null);
    setScanResult(null);

    async function startScanner() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        cameraStreamRef.current = stream;
        setCameraActive(true);

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        const scanLoop = () => {
          if (cancelled) return;
          const video = videoRef.current;
          const canvas = scanCanvasRef.current;
          if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = jsQR(imgData.data, imgData.width, imgData.height, {
                inversionAttempts: 'attemptBoth',
              });
              if (code && code.data) {
                handleDecodedPayload(code.data);
                return;
              }
            }
          }
          rafRef.current = requestAnimationFrame(scanLoop);
        };

        rafRef.current = requestAnimationFrame(scanLoop);
      } catch {
        if (!cancelled) {
          setScanError(
            'Kamera tidak dapat diakses di perangkat ini. Gunakan tombol Upload Gambar Barcode di bawah.'
          );
          setCameraActive(false);
        }
      }
    }

    startScanner();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [isOpen, activeTab, handleDecodedPayload, stopCamera]);

  const handleImageFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanError(null);

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imgData.data, imgData.width, imgData.height, {
          inversionAttempts: 'attemptBoth',
        });
        if (code && code.data) {
          handleDecodedPayload(code.data);
        } else {
          setScanError(
            'Barcode / QR tidak terdeteksi pada gambar tersebut. Pastikan gambar jelas.'
          );
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleDownloadBarcodeCard = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 520;
    canvas.height = 680;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#030812';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#00FFFF';
    ctx.lineWidth = 3;
    ctx.strokeRect(14, 14, canvas.width - 28, canvas.height - 28);

    ctx.fillStyle = '#00FFFF';
    ctx.font = 'bold 22px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('S.I.G.M.A DISKOMLEKAU', canvas.width / 2, 58);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px "JetBrains Mono", monospace';
    ctx.fillText(
      activeTab === 'SHARE_APK'
        ? 'WEBAPK STANDALONE DEPLOYMENT BARCODE'
        : `CLIENT NODE PAIRING BARCODE // ID: ${selectedNodeId}`,
      canvas.width / 2,
      82
    );

    if (qrDataUrl) {
      const img = new Image();
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = qrDataUrl;
      });
      ctx.drawImage(img, (canvas.width - 320) / 2, 110, 320, 320);
    }

    const bars = generateLinearBars(linearBarcodeText);
    const totalUnits = bars.reduce((a, b) => a + b, 0);
    const barAreaWidth = 340;
    const unitWidth = barAreaWidth / totalUnits;
    let curX = (canvas.width - barAreaWidth) / 2;

    for (let i = 0; i < bars.length; i++) {
      const w = bars[i] * unitWidth;
      if (i % 2 === 0) {
        ctx.fillStyle = '#00FFFF';
        ctx.fillRect(curX, 455, w, 52);
      }
      curX += w;
    }

    ctx.fillStyle = '#e0f2fe';
    ctx.font = 'bold 16px "JetBrains Mono", monospace';
    ctx.fillText(linearBarcodeText, canvas.width / 2, 532);

    ctx.fillStyle = '#67e8f9';
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillText(
      activeTab === 'SHARE_APK'
        ? 'SCAN DENGAN KAMERA HP UNTUK INSTALL WEBAPK S.I.G.M.A'
        : `SCAN DI HP CLIENT UNTUK AUTO-JOIN NODE ${selectedNodeId}`,
      canvas.width / 2,
      575
    );

    ctx.fillStyle = '#475569';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillText(activeUrl.slice(0, 62), canvas.width / 2, 610);

    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download =
      activeTab === 'SHARE_APK'
        ? `SIGMA_WEBAPK_BARCODE_${selectedNodeId}.png`
        : `SIGMA_CLIENT_JOIN_NODE_${selectedNodeId}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(activeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title:
            activeTab === 'SHARE_APK'
              ? 'S.I.G.M.A. WebAPK Installer'
              : `S.I.G.M.A. Join Client Node (${selectedNodeId})`,
          text:
            activeTab === 'SHARE_APK'
              ? 'Install aplikasi S.I.G.M.A. Remote Audio Telemetry (WebAPK):'
              : `Klik atau scan untuk mengaktifkan HP sebagai Client Node (${selectedNodeId}):`,
          url: activeUrl,
        });
      } catch {}
    } else {
      handleCopyUrl();
    }
  };

  if (!isOpen) return null;

  const linearBars = generateLinearBars(linearBarcodeText);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 backdrop-blur-xs p-3 sm:p-4 select-none">
      <div className="w-full max-w-xl bg-[#040b16] border border-cyan-500/55 rounded p-4 sm:p-6 text-cyan-50 font-mono-tactical shadow-2xl border-glow-cyan max-h-[94vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3 border-b border-cyan-500/30">
          <div className="flex items-center gap-2">
            <QrCode className="w-5 h-5 text-cyan-400" />
            <div>
              <h2 className="text-sm sm:text-base font-bold tracking-wider text-cyan-300">
                TACTICAL BARCODE PAIRING &amp; WEBAPK SHARE
              </h2>
              <p className="text-[10px] text-slate-400">
                CLIENT HP AUTO-JOIN VIA QR/BARCODE · DISTRIBUSI APK TANPA KABEL
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-cyan-300 bg-cyan-950/30 border border-cyan-500/30 rounded cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-1.5 bg-[#02060d] p-1 rounded border border-cyan-500/30 text-xs">
          <button
            onClick={() => setActiveTab('CLIENT_JOIN')}
            className={`py-2 px-2 rounded font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === 'CLIENT_JOIN'
                ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-400/60'
                : 'text-slate-400 hover:text-cyan-200'
            }`}
          >
            <Radio className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span>JOIN CLIENT</span>
          </button>

          <button
            onClick={() => setActiveTab('SHARE_APK')}
            className={`py-2 px-2 rounded font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === 'SHARE_APK'
                ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/60'
                : 'text-slate-400 hover:text-emerald-200'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>SHARE APK</span>
          </button>

          <button
            onClick={() => setActiveTab('SCANNER')}
            className={`py-2 px-2 rounded font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === 'SCANNER'
                ? 'bg-amber-500/25 text-amber-200 border border-amber-400/60'
                : 'text-slate-400 hover:text-amber-200'
            }`}
          >
            <ScanLine className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>SCAN BARCODE</span>
          </button>
        </div>

        {activeTab !== 'SCANNER' ? (
          <div className="mt-4 space-y-4">
            {activeTab === 'CLIENT_JOIN' ? (
              <div className="bg-[#071324] border border-cyan-500/30 rounded p-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] text-slate-300">
                  ID 4-DIGIT UNTUK HP CLIENT BARU:
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    maxLength={4}
                    value={selectedNodeId}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '');
                      setSelectedNodeId(val);
                    }}
                    placeholder="4-DIGIT"
                    className="w-24 bg-[#02060d] border border-cyan-500/40 rounded px-2.5 py-1 text-xs font-bold text-cyan-300 text-center"
                  />
                  <button
                    onClick={() =>
                      setSelectedNodeId(String(Math.floor(1000 + Math.random() * 9000)))
                    }
                    className="flex items-center gap-1 px-2.5 py-1 text-[11px] bg-cyan-950/60 border border-cyan-500/40 text-cyan-200 rounded hover:border-cyan-400 cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>ACAK ID</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="bg-[#071324] border border-emerald-500/30 rounded p-3 space-y-2">
                <div className="text-[11px] text-slate-300">
                  PILIH PAKET INSTALASI WEBAPK YANG AKAN DIBAGIKAN VIA BARCODE:
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    onClick={() => setApkTargetRole('NODE_CLIENT')}
                    className={`p-2.5 rounded border text-left transition-colors cursor-pointer ${
                      apkTargetRole === 'NODE_CLIENT'
                        ? 'bg-emerald-950/60 border-emerald-400 text-emerald-200'
                        : 'bg-[#030914] border-slate-800 text-slate-400'
                    }`}
                  >
                    <div className="text-xs font-bold">CLIENT TRANSMITTER APK</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">
                      HP yang scan langsung membuka &amp; menginstall mode Node ({selectedNodeId})
                    </div>
                  </button>

                  <button
                    onClick={() => setApkTargetRole('FULL_SUITE')}
                    className={`p-2.5 rounded border text-left transition-colors cursor-pointer ${
                      apkTargetRole === 'FULL_SUITE'
                        ? 'bg-cyan-950/60 border-cyan-400 text-cyan-200'
                        : 'bg-[#030914] border-slate-800 text-slate-400'
                    }`}
                  >
                    <div className="text-xs font-bold">FULL S.I.G.M.A SUITE APK</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">
                      Install aplikasi lengkap (bisa pilih Master Monitor atau Node)
                    </div>
                  </button>
                </div>
              </div>
            )}

            <div className="bg-[#030812] border border-cyan-500/45 rounded p-4 flex flex-col items-center text-center space-y-3">
              <div className="text-[11px] tracking-widest text-cyan-400 font-semibold uppercase">
                {activeTab === 'SHARE_APK'
                  ? 'SCAN BARCODE UNTUK DOWNLOAD / INSTALL WEBAPK'
                  : `SCAN BARCODE DI HP CLIENT UNTUK AUTO-JOIN NODE (${selectedNodeId})`}
              </div>

              <div className="p-2.5 bg-[#030812] border-2 border-cyan-400/70 rounded shadow-[0_0_25px_rgba(0,255,255,0.18)]">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="Tactical QR Barcode"
                    className="w-52 h-52 sm:w-60 sm:h-60 object-contain block"
                  />
                ) : (
                  <div className="w-52 h-52 sm:w-60 sm:h-60 flex items-center justify-center text-xs text-slate-500">
                    GENERATING BARCODE...
                  </div>
                )}
              </div>

              <div className="w-full max-w-xs pt-1 flex flex-col items-center">
                <div className="w-full h-10 bg-[#02050b] border border-cyan-500/30 px-3 py-1.5 flex items-stretch justify-center gap-[1px]">
                  {linearBars.map((w, idx) => (
                    <div
                      key={idx}
                      style={{
                        flexGrow: w,
                        backgroundColor: idx % 2 === 0 ? '#00FFFF' : 'transparent',
                      }}
                    />
                  ))}
                </div>
                <div className="text-xs font-bold tracking-[0.25em] text-cyan-200 mt-1">
                  {linearBarcodeText}
                </div>
              </div>

              <p className="text-[11px] text-slate-300 max-w-md leading-relaxed">
                {activeTab === 'SHARE_APK' ? (
                  <>
                    Arahkan kamera HP Android / iOS ke barcode di atas. Setelah terbuka, ketuk{' '}
                    <strong className="text-emerald-300">INSTALL WEBAPK</strong> untuk memasang{' '}
                    <code className="text-cyan-300">SysAudio</code> di layar utama HP.
                  </>
                ) : (
                  <>
                    Arahkan kamera HP Client ke kode di atas. HP Client akan otomatis masuk ke{' '}
                    <strong className="text-cyan-300">NODE MODE ({selectedNodeId})</strong> dan
                    langsung terhubung (WebRTC Connected) ke Master ini.
                  </>
                )}
              </p>

              <div className="w-full flex items-center gap-1.5 bg-[#06101e] border border-cyan-500/30 rounded px-2.5 py-1.5 text-[11px]">
                <input
                  type="text"
                  readOnly
                  value={activeUrl}
                  className="w-full bg-transparent text-slate-300 focus:outline-none truncate"
                />
                <button
                  onClick={handleCopyUrl}
                  className="flex items-center gap-1 px-2.5 py-1 bg-cyan-500/20 border border-cyan-400/50 text-cyan-200 rounded hover:bg-cyan-500/30 shrink-0 cursor-pointer"
                >
                  {copied ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-300">COPIED</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>COPY LINK</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={handleDownloadBarcodeCard}
                  className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-cyan-500/20 border border-cyan-400 text-cyan-200 rounded hover:bg-cyan-500/30 transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>UNDUH GAMBAR BARCODE (.PNG)</span>
                </button>

                <button
                  onClick={handleNativeShare}
                  className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-500/20 border border-emerald-400 text-emerald-200 rounded hover:bg-emerald-500/30 transition-colors cursor-pointer"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>SHARE KE WHATSAPP / HP LAIN</span>
                </button>
              </div>

              {activeTab === 'SHARE_APK' && isInstallable && (
                <button
                  onClick={() => install()}
                  className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold bg-amber-500/25 border border-amber-400 text-amber-200 rounded hover:bg-amber-500/35 cursor-pointer"
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  <span>INSTALL DI PERANGKAT INI</span>
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="bg-[#030812] border border-amber-500/45 rounded p-4 flex flex-col items-center text-center space-y-3">
              <div className="flex items-center gap-2 text-xs font-bold text-amber-300">
                <Camera className="w-4 h-4 text-amber-400" />
                <span>OPTICAL QR / BARCODE SCANNER</span>
              </div>

              <div className="relative w-full max-w-sm aspect-square bg-black border-2 border-amber-400/60 rounded overflow-hidden flex items-center justify-center">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                <canvas ref={scanCanvasRef} className="hidden" />

                <div className="absolute inset-8 border-2 border-dashed border-cyan-400/60 rounded pointer-events-none flex items-center justify-center">
                  <div className="w-full h-0.5 bg-red-500/70 animate-pulse shadow-[0_0_10px_#ef4444]" />
                </div>

                {!cameraActive && (
                  <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center p-4 text-xs text-slate-400 space-y-2">
                    <ScanLine className="w-8 h-8 text-amber-400 animate-pulse" />
                    <span>{scanError || 'MENGAKTIFKAN KAMERA...'}</span>
                  </div>
                )}
              </div>

              {scanResult && (
                <div className="w-full bg-emerald-950/60 border border-emerald-400 rounded p-2.5 text-xs text-emerald-200 flex items-center justify-between">
                  <span className="truncate">TERDETEKSI: {scanResult}</span>
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                </div>
              )}

              {scanError && (
                <div className="w-full bg-amber-950/50 border border-amber-500/50 rounded p-2.5 text-[11px] text-amber-200">
                  {scanError}
                </div>
              )}

              <div className="w-full pt-2 flex flex-wrap items-center justify-center gap-3">
                <label className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-cyan-500/20 border border-cyan-400 text-cyan-200 rounded hover:bg-cyan-500/30 cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  <span>UPLOAD GAMBAR BARCODE (.PNG / .JPG)</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageFileUpload}
                    className="hidden"
                  />
                </label>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BarcodeModal;
