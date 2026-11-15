/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  Radio,
  Shield,
  Activity,
  Navigation,
  Lock,
  Disc,
  Mic,
  Terminal,
  QrCode,
  Smartphone,
  ScanLine,
  EyeOff,
} from 'lucide-react';
import { Master } from './Master';
import { Client } from './Client';
import { PWAInstallButton, OfflineIndicator } from './PWAInstallButton';
import { BarcodeModal } from './BarcodeModal';
import { TacticalBlackout } from './TacticalBlackout';
import { initUniversalRoleAssignment } from './dynamicRoleAssignment';

type AppRole = 'LANDING' | 'MASTER' | 'NODE';

export default function App() {
  const [role, setRole] = useState<AppRole>(() => {
    const params = new URLSearchParams(window.location.search);
    const m = params.get('mode')?.toUpperCase();
    if (m === 'MASTER') return 'MASTER';
    if (m === 'NODE' || m === 'CLIENT') return 'NODE';
    if (params.get('id')) return 'NODE';
    return 'LANDING';
  });

  const [manualOverride, setManualOverride] = useState<boolean>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('autorole') !== '1';
  });

  const [pairedNodeId, setPairedNodeId] = useState<string | undefined>(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id')?.replace('sigma-node-', '').trim();
    return id && /^\d{4}$/.test(id) ? id : undefined;
  });

  const [pairedMasterId, setPairedMasterId] = useState<string | undefined>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('master') || undefined;
  });

  const [barcodeModalOpen, setBarcodeModalOpen] = useState<boolean>(false);
  const [barcodeModalTab, setBarcodeModalTab] = useState<
    'CLIENT_JOIN' | 'SHARE_APK' | 'SCANNER'
  >('CLIENT_JOIN');

  const [clock, setClock] = useState<string>('18:21:54:00');

  // Dynamic Role Assignment: Aktif jika parameter ?autorole=1 digunakan
  useEffect(() => {
    if (manualOverride || role !== 'LANDING') return;

    let roleClient: ReturnType<typeof initUniversalRoleAssignment> | null = null;

    const initMasterMode = () => {
      roleClient?.disconnect();
      setRole('MASTER');
    };

    const initClientMode = (info: { peerId: string; masterId: string | null }) => {
      roleClient?.disconnect();
      if (info.peerId) {
        setPairedNodeId(info.peerId);
      }
      setRole('NODE');
    };

    roleClient = initUniversalRoleAssignment({
      initMasterMode,
      initClientMode,
    });

    return () => {
      roleClient?.disconnect();
    };
  }, [manualOverride, role]);

  useEffect(() => {
    let raf: number;
    const updateClock = () => {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const ms = String(Math.floor(d.getMilliseconds() / 10)).padStart(2, '0');
      setClock(`${hh}:${mm}:${ss}:${ms}`);
      raf = requestAnimationFrame(updateClock);
    };
    raf = requestAnimationFrame(updateClock);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (role === 'MASTER') {
    return (
      <>
        <OfflineIndicator />
        <Master
          onExit={() => {
            setManualOverride(true);
            setRole('LANDING');
          }}
        />
      </>
    );
  }

  if (role === 'NODE') {
    return (
      <>
        <OfflineIndicator />
        <Client
          onExit={() => {
            setManualOverride(true);
            setRole('LANDING');
          }}
          initialNodeId={pairedNodeId}
          initialMasterPeerId={pairedMasterId}
        />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-[#02060d] tactical-grid-bg text-cyan-50 font-mono-tactical flex flex-col justify-between select-none">
      <OfflineIndicator />

      <BarcodeModal
        isOpen={barcodeModalOpen}
        onClose={() => setBarcodeModalOpen(false)}
        initialTab={barcodeModalTab}
        defaultNodeId={pairedNodeId}
        masterPeerId={pairedMasterId}
        onScanNodeId={(scannedId, scannedMasterId) => {
          setPairedNodeId(scannedId);
          if (scannedMasterId) setPairedMasterId(scannedMasterId);
          setRole('NODE');
        }}
      />

      {/* Top Tactical Navigation Contract: Logo TNI AU di Pojok Kiri Atas & Logo Petir di Pojok Kanan Atas */}
      <header className="border-b border-cyan-500/30 bg-[#040a14]/90 px-4 sm:px-8 py-3.5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 shrink-0">
          <img
            src="/assets/aistudio/images__10__b9efa126.jpeg"
            alt="Logo TNI AU"
            referrerPolicy="no-referrer"
            className="w-6 h-6 sm:w-7 sm:h-7 object-contain rounded-full border border-cyan-500/40 bg-black p-0.5 shrink-0"
          />
          <div className="font-display-tactical text-lg sm:text-xl font-bold tracking-wider text-cyan-300 text-glow-cyan whitespace-nowrap">
            S.I.G.M.A DISKOMLEKAU
          </div>
        </div>

        <nav className="hidden md:flex items-center gap-6 text-xs text-slate-300">
          <button
            onClick={() => setRole('MASTER')}
            className="hover:text-cyan-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Master Monitor
          </button>
          <button
            onClick={() => setRole('NODE')}
            className="hover:text-cyan-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Field Node
          </button>
          <button
            onClick={() => {
              setBarcodeModalTab('CLIENT_JOIN');
              setBarcodeModalOpen(true);
            }}
            className="hover:text-cyan-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Join Barcode
          </button>
          <button
            onClick={() => {
              setBarcodeModalTab('SHARE_APK');
              setBarcodeModalOpen(true);
            }}
            className="hover:text-emerald-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Share APK Barcode
          </button>
          <span className="text-cyan-400 font-semibold whitespace-nowrap shrink-0">
            {clock}
          </span>
        </nav>

        <div className="flex items-center gap-2.5 shrink-0">
          <PWAInstallButton />
          <img
            src="/assets/aistudio/1794622160588-picsay_109de27f.png"
            alt="Logo Petir Diskomlekau"
            referrerPolicy="no-referrer"
            className="w-6 h-6 sm:w-7 sm:h-7 object-contain rounded-full border border-cyan-500/40 bg-[#040d1a] p-0.5 shrink-0"
          />
        </div>
      </header>

      {/* Main Role Selection Stage */}
      <main className="my-auto max-w-5xl w-full mx-auto px-4 sm:px-8 py-8 space-y-6">
        {/* Title & System Telemetry Header */}
        <div className="border border-cyan-500/35 bg-[#050d1a]/95 rounded p-6 sm:p-8 border-glow-cyan space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-cyan-400 border-b border-cyan-500/20 pb-3">
            <span>SYSTEM GATEWAY &amp; MONITORING AUDIO // P2P WEBRTC ARCHITECTURE</span>
            <span>OP-STATUS: FULL ACTIVE · CRYPT: AES-GCM-256 · MAX NODES: 05</span>
          </div>

          <div className="space-y-2">
            <h1 className="font-display-tactical text-3xl sm:text-5xl font-bold tracking-wider text-cyan-300 text-glow-cyan">
              S.I.G.M.A DISKOMLEKAU
            </h1>
            <p className="text-xs sm:text-sm text-slate-300 max-w-2xl leading-relaxed">
              Remote Environmental Audio Telemetry &amp; Hands-Free Accessibility Gateway.
              Select terminal operational role below or use QR/Barcode pairing to join a
              Client phone and distribute the standalone WebAPK.
            </p>
          </div>

          {/* Quick Barcode Pairing & APK Distribution Bar */}
          <div className="pt-2 flex flex-wrap items-center gap-2.5">
            <button
              onClick={() => {
                setBarcodeModalTab('CLIENT_JOIN');
                setBarcodeModalOpen(true);
              }}
              className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold bg-cyan-500/20 border border-cyan-400 text-cyan-200 rounded hover:bg-cyan-500/30 transition-colors cursor-pointer"
            >
              <QrCode className="w-4 h-4 text-cyan-400" />
              <span>JOIN CLIENT VIA BARCODE</span>
            </button>

            <button
              onClick={() => {
                setBarcodeModalTab('SHARE_APK');
                setBarcodeModalOpen(true);
              }}
              className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold bg-emerald-500/20 border border-emerald-400 text-emerald-200 rounded hover:bg-emerald-500/30 transition-colors cursor-pointer"
            >
              <Smartphone className="w-4 h-4 text-emerald-400" />
              <span>SHARE APK VIA BARCODE</span>
            </button>

            <button
              onClick={() => {
                setBarcodeModalTab('SCANNER');
                setBarcodeModalOpen(true);
              }}
              className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold bg-amber-500/20 border border-amber-400 text-amber-200 rounded hover:bg-amber-500/30 transition-colors cursor-pointer"
            >
              <ScanLine className="w-4 h-4 text-amber-400" />
              <span>SCAN BARCODE KAMERA</span>
            </button>

            <button
              onClick={() => TacticalBlackout.engage()}
              className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold bg-slate-900/90 border border-cyan-500/50 text-cyan-200 rounded hover:bg-cyan-950/60 transition-colors cursor-pointer"
              title="Aktifkan Covert/Blackout OLED Mode (Ketuk 5x cepat < 2 detik untuk keluar)"
            >
              <EyeOff className="w-4 h-4 text-cyan-400" />
              <span>COVERT BLACKOUT (5x TAP EXIT)</span>
            </button>
          </div>
        </div>

        {/* Dual Role Selector Cards: ENTER MASTER MODE & ENTER NODE MODE */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card 1: MASTER MODE */}
          <div className="border border-cyan-500/45 bg-[#06101e]/95 rounded p-6 flex flex-col justify-between space-y-6 border-glow-cyan hover:border-cyan-400 transition-colors">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold tracking-widest text-cyan-400">
                  ROLE 01 // COMMAND MONITOR
                </span>
                <Activity className="w-5 h-5 text-cyan-400" />
              </div>

              <h2 className="font-display-tactical text-2xl font-bold tracking-wide text-white">
                MASTER MODE (DASHBOARD)
              </h2>

              <p className="text-xs text-slate-300 leading-relaxed">
                Central tactical monitoring station supporting up to 5 simultaneous field
                Nodes with real-time Cyber Cyan WebRTC waveform visualizers, digital Gain
                amplification, Solo channel isolation, and Leaflet GPS telemetry mapping.
              </p>

              <div className="space-y-2 pt-2 border-t border-cyan-500/20 text-xs text-slate-300">
                <div className="flex items-center gap-2">
                  <Disc className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span>Immediate &amp; VOX Auto-Record (10s silence auto-stop)</span>
                </div>
                <div className="flex items-center gap-2">
                  <Navigation className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span>Live Leaflet Tactical GPS Map with MGRS HUD overlays</span>
                </div>
                <div className="flex items-center gap-2">
                  <Shield className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span>5 Concurrent Node Channels + Per-Node QR Barcode Pairing</span>
                </div>
              </div>
            </div>

            <button
              onClick={() => setRole('MASTER')}
              className="w-full py-3.5 px-5 bg-cyan-500/20 hover:bg-cyan-500/35 border border-cyan-400 text-cyan-200 font-bold text-sm tracking-widest rounded transition-all cursor-pointer shadow-[0_0_20px_rgba(0,255,255,0.2)]"
            >
              ENTER MASTER MODE
            </button>
          </div>

          {/* Card 2: NODE MODE */}
          <div className="border border-cyan-500/35 bg-[#040912]/95 rounded p-6 flex flex-col justify-between space-y-6 hover:border-cyan-400 transition-colors">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold tracking-widest text-emerald-400">
                  ROLE 02 // FIELD TRANSMITTER
                </span>
                <Radio className="w-5 h-5 text-emerald-400" />
              </div>

              <h2 className="font-display-tactical text-2xl font-bold tracking-wide text-white">
                NODE MODE (TRANSMITTER)
              </h2>

              <p className="text-xs text-slate-300 leading-relaxed">
                Zero-glare #000000 OLED battery-saving transmitter unit. Auto-generates a
                4-digit numeric PeerJS ID or joins automatically via Barcode scan, disables
                noise/echo filters for raw ambient capture, and answers Master calls hands-free.
              </p>

              <div className="space-y-2 pt-2 border-t border-cyan-500/20 text-xs text-slate-300">
                <div className="flex items-center gap-2">
                  <Mic className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Raw Ambient WebRTC Audio (EC: false, NS: false, AGC: false)</span>
                </div>
                <div className="flex items-center gap-2">
                  <Lock className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Screen Wake Lock API + Pure Black OLED Stealth Mode</span>
                </div>
                <div className="flex items-center gap-2">
                  <Terminal className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Auto-Join via QR Barcode &amp; 10s GPS DataChannel telemetry</span>
                </div>
              </div>
            </div>

            <button
              onClick={() => setRole('NODE')}
              className="w-full py-3.5 px-5 bg-emerald-500/20 hover:bg-emerald-500/35 border border-emerald-400 text-emerald-200 font-bold text-sm tracking-widest rounded transition-all cursor-pointer shadow-[0_0_20px_rgba(16,185,129,0.18)]"
            >
              ENTER NODE MODE
            </button>
          </div>
        </div>
      </main>

      {/* Quiet Tactical Footer */}
      <footer className="border-t border-cyan-500/20 bg-[#03070e] px-4 sm:px-8 py-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
        <span>S.I.G.M.A DISKOMLEKAU · SYSTEM GATEWAY &amp; MONITORING AUDIO</span>
        <span>BARCODE PAIRING &amp; WEBAPK STANDALONE READY</span>
      </footer>
    </div>
  );
}
