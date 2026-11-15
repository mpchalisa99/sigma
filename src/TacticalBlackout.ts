/**
 * TacticalBlackout — Standalone Agnostic Covert / Blackout Mode Utility
 * Zero UI-framework dependencies. Pure Web API / Vanilla JS compatible.
 *
 * Fitur:
 * 1. TacticalBlackout.engage():
 *    - Meminta Fullscreen (`document.documentElement.requestFullscreen()`) untuk menyembunyikan status bar OS.
 *    - Meminta Screen Wake Lock (`navigator.wakeLock.request('screen')`) agar layar tidak sleep.
 *    - Menyuntikkan elemen overlay `<div>` 100vw x 100vh berwarna hitam pekat OLED (#000000)
 *      dengan z-index maksimal (2147483647) ke dalam DOM secara dinamis.
 * 2. Secret Exit (5x Ketukan Cepat < 2 Detik) / TacticalBlackout.disengage():
 *    - Mendeteksi 5 ketukan cepat dalam jendela waktu < 2000ms pada overlay hitam.
 *    - Menghapus elemen overlay hitam dari DOM.
 *    - Melepaskan Wake Lock (`wakeLockSentinel.release()`).
 *    - Keluar dari mode Fullscreen (`document.exitFullscreen()`).
 */

export class TacticalBlackout {
  private static overlayElement: HTMLDivElement | null = null;
  private static wakeLockSentinel: WakeLockSentinel | null = null;
  private static tapTimestamps: number[] = [];
  private static isActive = false;

  private static readonly overlayId = 'tactical-blackout-oled-overlay';
  private static readonly requiredTaps = 5;
  private static readonly tapWindowMs = 2000;

  /**
   * Mengaktifkan Covert / Blackout Mode pada perangkat mana pun.
   */
  public static async engage(): Promise<void> {
    if (typeof document === 'undefined') return;

    this.isActive = true;
    this.tapTimestamps = [];

    // 1. Suntikkan overlay hitam pekat OLED (#000000) ke dalam DOM terlebih dahulu
    this.injectBlackoutOverlay();

    // 2. Eksekusi Fullscreen API untuk menyembunyikan status bar & navigation bar OS
    await this.requestFullscreenSafe();

    // 3. Eksekusi Screen Wake Lock API agar perangkat tidak masuk mode sleep
    await this.requestWakeLockSafe();

    // Pasang listener visibilitychange agar Wake Lock otomatis diminta ulang jika tab kembali aktif
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  /**
   * Menonaktifkan Covert / Blackout Mode (dipanggil otomatis saat 5x ketukan cepat < 2 detik).
   */
  public static async disengage(): Promise<void> {
    this.isActive = false;
    this.tapTimestamps = [];

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }

    // a. Hapus elemen overlay hitam dari DOM
    this.removeBlackoutOverlay();

    // b. Lepaskan Screen Wake Lock
    await this.releaseWakeLockSafe();

    // c. Keluar dari mode Fullscreen
    await this.exitFullscreenSafe();
  }

  /**
   * Mengecek apakah Blackout Mode sedang aktif.
   */
  public static isEngaged(): boolean {
    return this.isActive;
  }

  /**
   * Membuat dan menyuntikkan elemen <div> overlay hitam OLED (100vw x 100vh) ke document.body.
   */
  private static injectBlackoutOverlay(): void {
    const existing = document.getElementById(this.overlayId) as HTMLDivElement | null;
    if (existing) {
      this.overlayElement = existing;
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = this.overlayId;
    overlay.setAttribute('aria-hidden', 'true');

    Object.assign(overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      backgroundColor: '#000000',
      zIndex: '2147483647',
      margin: '0',
      padding: '0',
      border: 'none',
      outline: 'none',
      cursor: 'none',
      userSelect: 'none',
      webkitUserSelect: 'none',
      touchAction: 'manipulation',
      webkitTapHighlightColor: 'transparent',
    });

    // Pasang pendeteksi 5x ketukan rahasia (< 2 detik)
    overlay.addEventListener('pointerdown', this.handleSecretTap, { passive: false });

    // Cegah menu konteks klik kanan / tahan lama agar penyamaran tidak terbuka
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());

    document.body.appendChild(overlay);
    this.overlayElement = overlay;
  }

  /**
   * Menghapus elemen overlay hitam dari DOM.
   */
  private static removeBlackoutOverlay(): void {
    if (this.overlayElement) {
      this.overlayElement.removeEventListener('pointerdown', this.handleSecretTap);
      if (this.overlayElement.parentNode) {
        this.overlayElement.parentNode.removeChild(this.overlayElement);
      }
      this.overlayElement = null;
    } else if (typeof document !== 'undefined') {
      const existing = document.getElementById(this.overlayId);
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    }
  }

  /**
   * Listener ketukan rahasia (Secret Exit):
   * 5 kali ketukan cepat dalam rentang waktu kurang dari 2 detik (2000ms).
   */
  private static handleSecretTap = (event: PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();

    const now = performance.now();

    // Simpan hanya ketukan yang berada dalam rentang < 2000ms terakhir
    this.tapTimestamps = this.tapTimestamps.filter(
      (timestamp) => now - timestamp < this.tapWindowMs
    );
    this.tapTimestamps.push(now);

    if (this.tapTimestamps.length >= this.requiredTaps) {
      const firstTapInWindow = this.tapTimestamps[this.tapTimestamps.length - this.requiredTaps];
      if (now - firstTapInWindow < this.tapWindowMs) {
        this.disengage();
      }
    }
  };

  /**
   * Meminta Fullscreen dengan fallback prefix vendor dan penanganan error aman.
   */
  private static async requestFullscreenSafe(): Promise<void> {
    try {
      const docEl = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>;
        msRequestFullscreen?: () => Promise<void>;
      };

      if (document.fullscreenElement) return;

      if (typeof docEl.requestFullscreen === 'function') {
        await docEl.requestFullscreen();
      } else if (typeof docEl.webkitRequestFullscreen === 'function') {
        await docEl.webkitRequestFullscreen();
      } else if (typeof docEl.msRequestFullscreen === 'function') {
        await docEl.msRequestFullscreen();
      }
    } catch (err) {
      console.warn('[TacticalBlackout] Fullscreen tidak diizinkan atau gagal:', err);
    }
  }

  /**
   * Keluar dari mode Fullscreen dengan aman.
   */
  private static async exitFullscreenSafe(): Promise<void> {
    try {
      const doc = document as Document & {
        webkitExitFullscreen?: () => Promise<void>;
        webkitFullscreenElement?: Element | null;
      };

      if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
        await document.exitFullscreen();
      } else if (doc.webkitFullscreenElement && typeof doc.webkitExitFullscreen === 'function') {
        await doc.webkitExitFullscreen();
      }
    } catch (err) {
      console.warn('[TacticalBlackout] Gagal keluar dari Fullscreen:', err);
    }
  }

  /**
   * Meminta Screen Wake Lock dengan penanganan error jika browser tidak mendukung.
   */
  private static async requestWakeLockSafe(): Promise<void> {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator) || !navigator.wakeLock) {
      console.warn('[TacticalBlackout] WakeLock API tidak didukung oleh browser perangkat ini.');
      return;
    }

    try {
      this.wakeLockSentinel = await navigator.wakeLock.request('screen');
      this.wakeLockSentinel.addEventListener('release', () => {
        this.wakeLockSentinel = null;
      });
    } catch (err) {
      console.warn('[TacticalBlackout] Gagal mengaktifkan Screen Wake Lock:', err);
    }
  }

  /**
   * Melepaskan Screen Wake Lock jika masih aktif.
   */
  private static async releaseWakeLockSafe(): Promise<void> {
    if (!this.wakeLockSentinel) return;
    try {
      await this.wakeLockSentinel.release();
    } catch (err) {
      console.warn('[TacticalBlackout] Gagal melepaskan Screen Wake Lock:', err);
    } finally {
      this.wakeLockSentinel = null;
    }
  }

  /**
   * Memastikan Wake Lock diaktifkan kembali jika aplikasi kembali terlihat saat Blackout masih aktif.
   */
  private static handleVisibilityChange = (): void => {
    if (
      this.isActive &&
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible' &&
      !this.wakeLockSentinel
    ) {
      this.requestWakeLockSafe();
    }
  };
}

// Ekspos ke global window agar dapat dipanggil dari konsol atau skrip eksternal mana pun
if (typeof window !== 'undefined') {
  (window as unknown as { TacticalBlackout: typeof TacticalBlackout }).TacticalBlackout =
    TacticalBlackout;
}

export default TacticalBlackout;
