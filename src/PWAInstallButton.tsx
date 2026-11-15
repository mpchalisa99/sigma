import React, { useState } from 'react';
import { Download, Smartphone, X, WifiOff } from 'lucide-react';
import { usePWAInstall, useOnlineStatus } from './usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showModal, setShowModal] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      await install();
    } else {
      setShowModal(true);
    }
  };

  return (
    <>
      <button
        onClick={handleClick}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-mono-tactical font-semibold tracking-wider text-cyan-300 bg-cyan-950/60 border border-cyan-500/40 rounded hover:bg-cyan-500/20 hover:border-cyan-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        title="Install S.I.G.M.A WebAPK / Standalone App"
      >
        <Download className="w-3.5 h-3.5 text-cyan-400" />
        <span>{isIOS ? 'INSTALL iOS' : 'INSTALL WEBAPK'}</span>
      </button>

      {showModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-xs p-4">
          <div className="w-full max-w-md bg-[#060d18] border border-cyan-500/50 rounded p-5 text-cyan-50 shadow-2xl font-mono-tactical">
            <div className="flex items-center justify-between pb-3 border-b border-cyan-500/20">
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-cyan-400" />
                <h3 className="text-sm font-bold tracking-wider text-cyan-300">
                  WEBAPK / STANDALONE DEPLOYMENT
                </h3>
              </div>
              <button
                onClick={() => setShowModal(false)}
                className="text-slate-400 hover:text-cyan-300 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3 text-xs text-slate-300 leading-relaxed">
              {isIOS ? (
                <>
                  <p className="text-cyan-200 font-semibold">iOS Safari Standalone Setup:</p>
                  <ol className="list-decimal list-inside space-y-1.5 text-slate-300">
                    <li>Tap the <strong>Share</strong> icon in the bottom Safari toolbar.</li>
                    <li>Scroll down and select <strong>Add to Home Screen</strong>.</li>
                    <li>Launch <strong>SysAudio</strong> from your home screen for fullscreen Wake Lock telemetry.</li>
                  </ol>
                </>
              ) : (
                <>
                  <p className="text-cyan-200 font-semibold">Android / Chromium WebAPK Setup:</p>
                  <ol className="list-decimal list-inside space-y-1.5 text-slate-300">
                    <li>Open this URL in <strong>Chrome for Android</strong> or desktop Chromium outside an iframe.</li>
                    <li>Tap the browser menu (<strong>⋮</strong>) and select <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
                    <li>Service Worker & Manifest (<code className="text-cyan-300">SysAudio</code>) are active and pre-cached for offline boot.</li>
                  </ol>
                </>
              )}
            </div>

            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-1.5 text-xs font-semibold bg-cyan-500/20 border border-cyan-400/50 text-cyan-200 rounded hover:bg-cyan-500/30 transition-colors cursor-pointer"
              >
                ACKNOWLEDGE
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-[9000] flex items-center gap-2 rounded bg-amber-950/95 border border-amber-500/60 px-3 py-1.5 text-xs font-mono-tactical text-amber-300 shadow-lg">
      <WifiOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
      <span>OFFLINE CACHE MODE — P2P LAN / LOCAL CAPTURE ACTIVE</span>
    </div>
  );
};
