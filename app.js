// ════════════════════════════════════════════════════
//   Canocchi Store — POS System  |  app.js
//   Firebase v10 Modular SDK + html5-qrcode
// ════════════════════════════════════════════════════

import { initializeApp }                     from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword,
         signOut, onAuthStateChanged }        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc,
         addDoc, getDoc, getDocs, setDoc,
         updateDoc, runTransaction, query,
         orderBy, limit, where,
         onSnapshot, serverTimestamp,
         Timestamp }                          from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Firebase Config ──────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyBg4WAoETa4fzO_eia4Nc9PraW_dkmeA4w",
  authDomain:        "canocchi-store---stock-control.firebaseapp.com",
  projectId:         "canocchi-store---stock-control",
  storageBucket:     "canocchi-store---stock-control.firebasestorage.app",
  messagingSenderId: "1062366040495",
  appId:             "1:1062366040495:web:2afb9007cc568d11fa1f5a",
  measurementId:     "G-9EB87X6949",
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ── State ────────────────────────────────────────────
let cart          = [];        // { id, barcode, name, price, quantity, stock }
let selectedMethod = null;     // payment method string
let html5QrCode   = null;      // scanner instance
let scannerActive = false;
let lastSaleData  = null;      // for ticket generation
let stockUnsubscribe = null;   // realtime listener
let stockHtml5QrCode   = null; // stock tab scanner instance
let stockScannerActive = false;
let lastScannedCode    = '';   // debounce: evitar doble escaneo del mismo código
let scanCooldown       = false;
let torchOn            = false; // linterna estado
let currentCamTrack    = null;  // track de la cámara activa para torch

// ── Beep on scan — sonido de escáner de supermercado (Web Audio API) ────────────
let _audioCtx = null;

function _getAudioCtx() {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}

function playBeep() {
  try {
    const ctx = _getAudioCtx();
    const now = ctx.currentTime;

    // Oscilador principal — tono típico de escáner Datalogic/Symbol (~1800Hz)
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1800, now);
    osc.frequency.exponentialRampToValueAtTime(1950, now + 0.04);
    osc.frequency.exponentialRampToValueAtTime(1800, now + 0.08);

    // Ganancia — ataque y decay rápidos, como escáner real
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.005);
    gain.gain.setValueAtTime(0.35, now + 0.06);
    gain.gain.linearRampToValueAtTime(0, now + 0.1);

    // Filtro para suavizar el square wave (quita los armónicos más duros)
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1850;
    filter.Q.value = 2.5;

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.12);
  } catch (_) {}
}

// ── Dark mode ─────────────────────────────────────────
(function initDarkMode() {
  const saved = localStorage.getItem('canocchi_dark');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (saved === 'dark' || (!saved && prefersDark)) {
    document.documentElement.classList.add('dark');
  }
})();

// ════════════════════════════════════════════════════
//   UTILITIES
// ════════════════════════════════════════════════════

const fmt   = (n) => `$${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);

function toast(msg, type = 'info') {
  const icons = { info: 'ℹ️', success: '✅', error: '❌' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'slideOut 0.3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

function showLoading(btnEl, text = 'Cargando...') {
  btnEl.disabled = true;
  btnEl._origText = btnEl.innerHTML;
  btnEl.innerHTML = `<svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg> ${text}`;
}
function stopLoading(btnEl) {
  btnEl.disabled = false;
  btnEl.innerHTML = btnEl._origText;
}

// ════════════════════════════════════════════════════
//   AUTH
// ════════════════════════════════════════════════════

document.getElementById('btnLogin').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const pass  = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');

  if (!email || !pass) { errEl.textContent = 'Completá todos los campos.'; errEl.classList.remove('hidden'); return; }

  const btn = document.getElementById('btnLogin');
  showLoading(btn, 'Ingresando...');

  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    const msgs = {
      'auth/user-not-found':  'Usuario no encontrado.',
      'auth/wrong-password':  'Contraseña incorrecta.',
      'auth/invalid-email':   'Email inválido.',
      'auth/invalid-credential': 'Credenciales inválidas.',
    };
    errEl.textContent = msgs[e.code] || 'Error al ingresar. Revisá tus datos.';
    errEl.classList.remove('hidden');
    stopLoading(btn);
  }
});

document.getElementById('loginPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btnLogin').click();
});

document.getElementById('btnLogout').addEventListener('click', async () => {
  await stopScanner();
  await signOut(auth);
});

// ── Dark mode toggle ──────────────────────────────────
document.getElementById('btnDarkMode').addEventListener('click', () => {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('canocchi_dark', isDark ? 'dark' : 'light');
  const sun  = document.getElementById('iconSun');
  const moon = document.getElementById('iconMoon');
  if (sun)  sun.classList.toggle('hidden', !isDark);
  if (moon) moon.classList.toggle('hidden', isDark);
});

onAuthStateChanged(auth, (user) => {
  if (user) {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
    document.getElementById('userEmail').textContent = user.email;
    initApp();
  } else {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('appShell').classList.add('hidden');
    if (stockUnsubscribe) stockUnsubscribe();
  }
});

// ════════════════════════════════════════════════════
//   TAB NAVIGATION
// ════════════════════════════════════════════════════

function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
  document.getElementById(`tab-${tabId}`).classList.remove('hidden');

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active-nav'));
  document.querySelector(`.nav-btn[data-tab="${tabId}"]`)?.classList.add('active-nav');

  document.querySelectorAll('.mob-nav').forEach(b => b.classList.remove('active-mob-nav'));
  document.querySelector(`.mob-nav[data-tab="${tabId}"]`)?.classList.add('active-mob-nav');

  if (tabId !== 'pos')   stopScanner();
  if (tabId !== 'stock') stopStockScanner();
  if (tabId === 'dashboard')  loadDashboard();
  if (tabId === 'cierre')     loadCierreHistorial();
  if (tabId === 'stock')      loadStockList();
  if (tabId === 'cajafuerte') loadCajaFuerteHistorial();
}

document.querySelectorAll('.nav-btn, .mob-nav').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ════════════════════════════════════════════════════
//   SCANNER — BarcodeDetector nativo + ZXing fallback
//   Auto-cierra la cámara al detectar un código
// ════════════════════════════════════════════════════

let _cameraStream    = null;
let _scanInterval    = null;
let _videoTrack      = null;
let _scanCanvas      = null;
let _scanCtx         = null;
let _scanRunning     = false;

function loadZXing() {
  return new Promise((resolve) => {
    if (window.ZXing) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/@zxing/library@0.18.6/umd/index.min.js';
    s.onload = resolve;
    s.onerror = resolve;
    document.head.appendChild(s);
  });
}

// Inicializa el BarcodeDetector nativo si está disponible
async function _initDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const det = new BarcodeDetector({
      formats: ['ean_13','ean_8','code_128','code_39','upc_a','upc_e','qr_code','itf','codabar','data_matrix']
    });
    return det;
  } catch(_) { return null; }
}

// Llamado cada vez que se detecta un código — cierra cámara y procesa
function _handleScannedCode(code) {
  if (scanCooldown || code === lastScannedCode) return;
  scanCooldown = true;
  lastScannedCode = code;
  setTimeout(() => { scanCooldown = false; lastScannedCode = ''; }, 2500);

  playBeep();
  // Detener inmediatamente la cámara
  stopScanner();
  // Buscar/agregar el producto
  addProductToCartByBarcode(code);
}

async function startScanner() {
  if (scannerActive) return;

  const statusEl = document.getElementById('scanStatus');
  const readerEl = document.getElementById('qr-reader');

  try {
    // Pedir cámara trasera, alta resolución para leer barcodes bien
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
      }
    });

    _cameraStream = stream;
    _videoTrack   = stream.getVideoTracks()[0];
    scannerActive = true;

    document.getElementById('btnStartScan').classList.add('hidden');
    document.getElementById('btnStopScan').classList.remove('hidden');

    // Mostrar linterna si el dispositivo la soporta
    const caps = _videoTrack.getCapabilities?.() || {};
    const torchBtn = document.getElementById('btnTorch');
    if (caps.torch) {
      torchBtn.classList.remove('hidden');
      torchBtn.classList.add('flex');
    }

    readerEl.innerHTML = `
      <div style="position:relative;width:100%;background:#000;border-radius:0.75rem;overflow:hidden;">
        <video id="scanner-video" autoplay playsinline muted
          style="width:100%;display:block;max-height:280px;object-fit:cover;"></video>
        <canvas id="scanner-canvas" style="display:none;"></canvas>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;">
          <div style="width:78%;height:36%;border:2.5px solid rgba(229,17,17,0.9);border-radius:8px;
                      box-shadow:0 0 0 9999px rgba(0,0,0,0.45);">
            <!-- Esquinas animadas -->
            <div style="position:absolute;top:-2px;left:-2px;width:18px;height:18px;
                        border-top:3px solid #fff;border-left:3px solid #fff;border-radius:3px 0 0 0;"></div>
            <div style="position:absolute;top:-2px;right:-2px;width:18px;height:18px;
                        border-top:3px solid #fff;border-right:3px solid #fff;border-radius:0 3px 0 0;"></div>
            <div style="position:absolute;bottom:-2px;left:-2px;width:18px;height:18px;
                        border-bottom:3px solid #fff;border-left:3px solid #fff;border-radius:0 0 0 3px;"></div>
            <div style="position:absolute;bottom:-2px;right:-2px;width:18px;height:18px;
                        border-bottom:3px solid #fff;border-right:3px solid #fff;border-radius:0 0 3px 0;"></div>
          </div>
        </div>
      </div>`;

    const video = document.getElementById('scanner-video');
    video.srcObject = stream;

    statusEl.textContent = 'Iniciando cámara…';

    // Esperar que el video esté listo
    await new Promise((resolve) => {
      if (video.readyState >= 2) { resolve(); return; }
      video.addEventListener('canplay', resolve, { once: true });
      setTimeout(resolve, 4000);
    });

    if (!scannerActive) return; // fue detenido mientras cargaba

    _scanCanvas = document.getElementById('scanner-canvas');
    _scanCtx    = _scanCanvas.getContext('2d', { willReadFrequently: true });

    // Intentar BarcodeDetector nativo (más rápido, sin librería externa)
    const nativeDetector = await _initDetector();

    if (nativeDetector) {
      statusEl.textContent = 'Apuntá el código al recuadro';
      _scanRunning = true;

      const loop = async () => {
        if (!_scanRunning || !scannerActive) return;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            const results = await nativeDetector.detect(video);
            if (results && results.length && results[0].rawValue) {
              _scanRunning = false;
              _handleScannedCode(results[0].rawValue);
              return; // no seguir loopeando
            }
          } catch(_) {}
        }
        _scanInterval = setTimeout(loop, 150); // ~6fps es suficiente para barcodes
      };
      loop();

    } else {
      // Fallback: ZXing via requestAnimationFrame
      statusEl.textContent = 'Cargando lector…';
      await loadZXing();

      if (!scannerActive) return;

      if (!window.ZXing) {
        statusEl.textContent = 'Usá el escáner físico o ingresá el código manualmente';
        return;
      }

      const hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
        ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8,
        ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.CODE_39,
        ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E,
        ZXing.BarcodeFormat.QR_CODE,
      ]);
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      const zxReader = new ZXing.MultiFormatReader();
      zxReader.setHints(hints);

      statusEl.textContent = 'Apuntá el código al recuadro';
      _scanRunning = true;

      const loop = () => {
        if (!_scanRunning || !scannerActive) return;
        _scanInterval = requestAnimationFrame(loop);
        if (!video || video.readyState < 2 || video.videoWidth === 0) return;
        _scanCanvas.width  = video.videoWidth;
        _scanCanvas.height = video.videoHeight;
        _scanCtx.drawImage(video, 0, 0);
        try {
          const imgData   = _scanCtx.getImageData(0, 0, _scanCanvas.width, _scanCanvas.height);
          const luminance = new ZXing.RGBLuminanceSource(imgData.data, _scanCanvas.width, _scanCanvas.height);
          const bitmap    = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));
          const result    = zxReader.decode(bitmap);
          if (result && result.getText()) {
            _scanRunning = false;
            _handleScannedCode(result.getText());
          }
        } catch(_) {}
      };
      loop();
    }

  } catch(e) {
    scannerActive = false;
    _cameraStream = null;
    document.getElementById('btnStartScan').classList.remove('hidden');
    document.getElementById('btnStopScan').classList.add('hidden');
    if (e.name === 'NotAllowedError') {
      toast('Permiso de cámara denegado. Habilitalo en la configuración del navegador.', 'error');
    } else {
      toast(`Error de cámara: ${e.message || e}`, 'error');
    }
  }
}

async function stopScanner() {
  _scanRunning = false;

  // Cancela tanto requestAnimationFrame como setTimeout
  if (_scanInterval !== null) {
    cancelAnimationFrame(_scanInterval);
    clearTimeout(_scanInterval);
    _scanInterval = null;
  }

  if (_videoTrack && torchOn) {
    _videoTrack.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
  }
  if (_cameraStream) {
    _cameraStream.getTracks().forEach(t => t.stop());
    _cameraStream = null;
  }

  scannerActive   = false;
  _videoTrack     = null;
  currentCamTrack = null;
  torchOn         = false;
  _scanCanvas     = null;
  _scanCtx        = null;

  const torchBtn = document.getElementById('btnTorch');
  if (torchBtn) { torchBtn.classList.add('hidden'); torchBtn.classList.remove('flex'); }
  const tl = document.getElementById('torchLabel');
  if (tl) tl.textContent = 'Linterna';
  document.getElementById('btnStartScan').classList.remove('hidden');
  document.getElementById('btnStopScan').classList.add('hidden');
  document.getElementById('scanStatus').textContent = '';
  document.getElementById('qr-reader').innerHTML = `
    <div class="text-center text-[#475569] dark:text-gray-400 p-8">
      <svg class="w-20 h-20 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
          d="M3 9V5a2 2 0 012-2h4M3 15v4a2 2 0 002 2h4m6-18h4a2 2 0 012 2v4m0 6v4a2 2 0 01-2 2h-4M9 9h6v6H9z"/>
      </svg>
      <p class="text-sm">Presioná "Activar Cámara" para escanear</p>
      <p class="text-xs mt-1 opacity-60">O ingresá el código manualmente abajo</p>
    </div>`;
}

document.getElementById('btnStartScan').addEventListener('click', startScanner);
document.getElementById('btnStopScan').addEventListener('click', stopScanner);

// Torch (linterna) toggle
document.getElementById('btnTorch').addEventListener('click', async () => {
  if (!_videoTrack) return;
  try {
    torchOn = !torchOn;
    await _videoTrack.applyConstraints({ advanced: [{ torch: torchOn }] });
    document.getElementById('torchLabel').textContent = torchOn ? 'Apagar' : 'Linterna';
    document.getElementById('btnTorch').style.color = torchOn ? '#f59e0b' : '';
  } catch(e) {
    toast('Linterna no disponible en este dispositivo', 'info');
    torchOn = false;
  }
});

// Manual / laser scanner input
const manualBarcodeInput = document.getElementById('manualBarcode');
document.getElementById('btnSearchBarcode').addEventListener('click', async () => {
  const code = manualBarcodeInput.value.trim();
  if (!code) return;
  playBeep();
  await addProductToCartByBarcode(code);
  manualBarcodeInput.value = '';
  manualBarcodeInput.focus();
});
manualBarcodeInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const code = manualBarcodeInput.value.trim();
    if (!code) return;
    playBeep();
    await addProductToCartByBarcode(code);
    manualBarcodeInput.value = '';
  }
});

// ════════════════════════════════════════════════════
//   PRODUCT LOOKUP
// ════════════════════════════════════════════════════

// Helper: restores focus to manual barcode input (for USB/pistola scanners)
function refocusBarcode() {
  const input = document.getElementById('manualBarcode');
  if (input) setTimeout(() => { input.focus(); input.select(); }, 150);
}

// ════════════════════════════════════════════════════
//   BALANZA / FIAMBRES — Decodificador EAN-13 precio-variable
//   Prefijos: 20-29 indican producto con peso/precio embebido
//   Formato estándar: PP PPPPP XXXXXC  (P=producto, X=precio/peso, C=check)
//   Retorna: { productCode, embeddedPrice } o null si no es balanza
// ════════════════════════════════════════════════════
function decodeScaleBarcode(barcode) {
  if (!barcode || barcode.length !== 13) return null;
  const prefix = parseInt(barcode.substring(0, 2));
  // Prefijos 20-29 = peso variable (estándar GS1 Argentina)
  if (prefix < 20 || prefix > 29) return null;

  // Formato balanza Argentina (ej: 2007010012403):
  // Dígitos 0-1  (2 dígitos) = prefijo (20-29)
  // Dígitos 2-6  (5 dígitos) = código PLU del producto (ej: 07010)
  // Dígitos 7-11 (5 dígitos) = peso en gramos x1000 (ej: 01240 = 1.240 kg)
  // Dígito  12   = dígito de control
  const productCode = barcode.substring(0, 7);  // ej: 2007010 (prefijo + PLU)
  const weightRaw   = parseInt(barcode.substring(7, 12)); // ej: 01240
  const weightKg    = weightRaw / 1000;                   // ej: 1.240 kg
  const weightG     = weightRaw;                          // ej: 1240 g

  return { productCode, weightKg, weightG, fullBarcode: barcode };
}

async function addProductToCartByBarcode(barcode) {
  const statusEl = document.getElementById('scanStatus');
  if (statusEl) statusEl.textContent = `Buscando: ${barcode}…`;

  try {
    // ── Detección balanza ─────────────────────────────
    const scaleData = decodeScaleBarcode(barcode);

    if (scaleData) {
      const docRef  = doc(db, 'productos', scaleData.productCode);
      const docSnap = await getDoc(docRef);

      if (!docSnap.exists()) {
        openScaleAddModal(scaleData);
        return;
      }

      const baseProduct = { id: scaleData.productCode, ...docSnap.data() };
      const pricePerKg  = baseProduct.pricePerKg || baseProduct.price || 0;
      openScaleWeightModal(baseProduct, pricePerKg, barcode);
      return;
    }

    // ── Producto normal ───────────────────────────────
    const docRef  = doc(db, 'productos', barcode);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      // Código no encontrado → modal de alta rápida con barcode ya cargado
      if (statusEl) statusEl.textContent = `Código ${barcode} no encontrado — registralo`;
      openQuickAddModal(barcode);
      return;
    }

    const product = { id: barcode, ...docSnap.data() };
    addToCart(product);
    if (statusEl) {
      statusEl.textContent = `✅ ${product.name} agregado`;
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2500);
    }
    refocusBarcode();
  } catch (e) {
    toast('Error al buscar producto', 'error');
    console.error(e);
  }
}

// Agregar producto de balanza al carrito (sin control de stock, cada ticket es único)
function addScaleProductToCart(product) {
  // Cada escaneo de balanza es un ítem independiente (precio diferente cada vez)
  cart.push({ ...product, quantity: 1, stock: 9999 });
  renderCart();
  toast(`⚖️ ${product.name} — ${product._weightKg.toFixed(3)} kg = ${fmt(product.price)}`, 'success');
}

// ── Scale Weight Modal (ingreso manual de peso) ───────────────────────────
let _pendingScaleBase    = null;
let _pendingScalePriceKg = 0;
let _pendingScaleBarcode = '';

function openScaleWeightModal(baseProduct, pricePerKg, barcode) {
  _pendingScaleBase    = baseProduct;
  _pendingScalePriceKg = pricePerKg;
  _pendingScaleBarcode = barcode;

  document.getElementById('swName').textContent       = baseProduct.name;
  document.getElementById('swPricePerKg').textContent = fmt(pricePerKg) + ' /kg';
  document.getElementById('swImporte').textContent    = '—';
  document.getElementById('swWeightInput').value      = '';
  document.getElementById('swMsg').textContent        = '';

  openModal('modalScaleWeight');
  setTimeout(() => document.getElementById('swWeightInput').focus(), 100);
}

document.getElementById('swWeightInput').addEventListener('input', () => {
  const g  = parseFloat(document.getElementById('swWeightInput').value) || 0;
  const kg = g / 1000;
  const importe = Math.round(_pendingScalePriceKg * kg * 100) / 100;
  document.getElementById('swImporte').textContent = g > 0 ? fmt(importe) : '—';
});

document.getElementById('btnScaleWeightConfirm').addEventListener('click', () => {
  const g = parseFloat(document.getElementById('swWeightInput').value);
  if (!g || g <= 0) {
    document.getElementById('swMsg').textContent = '⚠️ Ingresá el peso en gramos';
    return;
  }
  const kg = g / 1000;
  const importe = Math.round(_pendingScalePriceKg * kg * 100) / 100;
  const product = {
    ..._pendingScaleBase,
    id:          _pendingScaleBarcode + '_' + Date.now(),
    price:       importe,
    _isScale:    true,
    _baseId:     _pendingScaleBase.id,
    _weightKg:   kg,
    _weightG:    g,
    _pricePerKg: _pendingScalePriceKg,
  };
  closeModal('modalScaleWeight');
  addScaleProductToCart(product);
  document.getElementById('scanStatus').textContent =
    `Balanza: ${_pendingScaleBase.name} — ${g}g = ${fmt(importe)}`;
  setTimeout(() => { document.getElementById('scanStatus').textContent = 'Listo para escanear'; }, 3000);
  refocusBarcode();
  _pendingScaleBase = null;
});

document.getElementById('btnScaleWeightCancel').addEventListener('click', () => {
  closeModal('modalScaleWeight');
  _pendingScaleBase = null;
  refocusBarcode();
});

// Enter en el campo de peso confirma
document.getElementById('swWeightInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btnScaleWeightConfirm').click();
});

// ── Scale Add Modal (alta de producto de balanza no registrado) ──────────
function openScaleAddModal(scaleData) {
  document.getElementById('saProductCode').value       = scaleData.productCode;
  document.getElementById('saWeightKg').value          = scaleData.weightKg.toFixed(3);
  document.getElementById('saWeightG').value           = scaleData.weightG;
  document.getElementById('saFullBarcode').value       = scaleData.fullBarcode || '';
  document.getElementById('saName').value              = '';
  document.getElementById('saPricePerKg').value        = '';
  document.getElementById('saMsg').textContent         = '';

  // Mostrar info detectada
  document.getElementById('saWeightDisplay').textContent = `${scaleData.weightKg.toFixed(3)} kg (${scaleData.weightG} g)`;
  document.getElementById('saCodeDisplay').textContent   = scaleData.productCode;
  document.getElementById('saImporteDisplay').textContent = '—';

  openModal('modalScaleAdd');
  setTimeout(() => document.getElementById('saName').focus(), 100);
}

document.getElementById('saPricePerKg').addEventListener('input', () => {
  const pricePerKg = parseFloat(document.getElementById('saPricePerKg').value) || 0;
  const weightKg   = parseFloat(document.getElementById('saWeightKg').value) || 0;
  const importe    = Math.round(pricePerKg * weightKg * 100) / 100;
  document.getElementById('saImporteDisplay').textContent = importe > 0 ? fmt(importe) : '—';
});

document.getElementById('btnSaveScaleAdd').addEventListener('click', async () => {
  const productCode = document.getElementById('saProductCode').value.trim();
  const name        = document.getElementById('saName').value.trim();
  const pricePerKg  = parseFloat(document.getElementById('saPricePerKg').value);
  const weightKg    = parseFloat(document.getElementById('saWeightKg').value);
  const weightG     = parseInt(document.getElementById('saWeightG').value);
  const fullBarcode = document.getElementById('saFullBarcode').value.trim();
  const msgEl       = document.getElementById('saMsg');

  if (!name || isNaN(pricePerKg) || pricePerKg <= 0) {
    msgEl.textContent = '⚠️ Completá el nombre y el precio por kg';
    msgEl.className   = 'text-xs text-yellow-400 font-mono text-center';
    return;
  }

  const btn = document.getElementById('btnSaveScaleAdd');
  showLoading(btn, 'Guardando...');

  try {
    const productData = {
      name,
      barcode:    productCode,
      isScale:    true,
      isCigarrillo: false,
      pricePerKg,
      price:      0,
      stock:      9999,
      section:    'Fiambres',
      brand:      '',
      createdAt:  serverTimestamp(),
      updatedAt:  serverTimestamp(),
    };

    await setDoc(doc(db, 'productos', productCode), productData, { merge: true });
    toast(`✅ "${name}" guardado — $${pricePerKg}/kg`, 'success');

    // Ahora agregar al carrito con el peso e importe correctos
    const importe = Math.round(pricePerKg * weightKg * 100) / 100;
    const cartProduct = {
      ...productData,
      id:          fullBarcode || productCode,
      price:       importe,
      _isScale:    true,
      _baseId:     productCode,
      _weightKg:   weightKg,
      _weightG:    weightG,
      _pricePerKg: pricePerKg,
    };

    closeModal('modalScaleAdd');
    addScaleProductToCart(cartProduct);
    document.getElementById('scanStatus').textContent =
      `⚖️ ${name} — ${weightKg.toFixed(3)} kg × ${fmt(pricePerKg)}/kg = ${fmt(importe)}`;
    setTimeout(() => { document.getElementById('scanStatus').textContent = '📡 Listo para escanear'; }, 3000);
    refocusBarcode();

  } catch (e) {
    msgEl.textContent = `❌ Error: ${e.message}`;
    msgEl.className   = 'text-xs text-red-400 font-mono text-center';
  } finally {
    stopLoading(btn);
  }
});

document.getElementById('closeModalScaleAdd').addEventListener('click', () => {
  closeModal('modalScaleAdd');
  refocusBarcode();
});

// ── Quick Add Modal ──────────────────────────────────
function openQuickAddModal(barcode) {
  document.getElementById('qaBarcode').value       = barcode;
  document.getElementById('qaBarcodeDisplay').textContent = barcode;
  document.getElementById('qaName').value          = '';
  document.getElementById('qaSection').value       = '';
  document.getElementById('qaBrand').value         = '';
  document.getElementById('qaPrice').value         = '';
  document.getElementById('qaStock').value         = '';
  document.getElementById('qaMsg').textContent     = '';
  document.getElementById('qaAddToCart').checked   = true;
  document.getElementById('qaIsCigarrillo').checked = false;
  openModal('modalQuickAdd');
  setTimeout(() => document.getElementById('qaName').focus(), 100);
}

document.getElementById('btnSaveQuickAdd').addEventListener('click', async () => {
  const barcode = document.getElementById('qaBarcode').value.trim();
  const name    = document.getElementById('qaName').value.trim();
  const section = document.getElementById('qaSection').value.trim();
  const brand   = document.getElementById('qaBrand').value.trim();
  const price   = parseFloat(document.getElementById('qaPrice').value);
  const stock   = parseInt(document.getElementById('qaStock').value);
  const addToCartAfter  = document.getElementById('qaAddToCart').checked;
  const isCigarrillo    = document.getElementById('qaIsCigarrillo').checked;
  const msgEl   = document.getElementById('qaMsg');

  if (!name || isNaN(price) || isNaN(stock)) {
    msgEl.textContent = '⚠️ Completá Nombre, Precio y Stock';
    msgEl.className   = 'text-xs text-yellow-400 font-mono text-center';
    return;
  }

  const btn = document.getElementById('btnSaveQuickAdd');
  showLoading(btn, 'Guardando...');

  try {
    const productData = { name, section, brand, price, stock, barcode, isCigarrillo,
                          createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    await setDoc(doc(db, 'productos', barcode), productData, { merge: true });

    toast(`✅ "${name}" guardado en inventario`, 'success');
    document.getElementById('scanStatus').textContent = `✅ Producto registrado: ${name}`;

    closeModal('modalQuickAdd');
    refocusBarcode();

    if (addToCartAfter) {
      addToCart({ id: barcode, ...productData });
      setTimeout(() => { document.getElementById('scanStatus').textContent = '📡 Listo para escanear'; }, 2000);
    }

    // Refresh stock list si está visible
    if (!document.getElementById('tab-stock').classList.contains('hidden')) loadStockList();

  } catch (e) {
    msgEl.textContent = `❌ Error: ${e.message}`;
    msgEl.className   = 'text-xs text-red-400 font-mono text-center';
  } finally {
    stopLoading(btn);
  }
});

document.getElementById('closeModalQuickAdd').addEventListener('click', () => { closeModal('modalQuickAdd'); refocusBarcode(); });

// Live search by name
document.getElementById('searchProduct').addEventListener('input', async (e) => {
  const q = e.target.value.trim().toLowerCase();
  const resultsEl = document.getElementById('searchResults');
  if (q.length < 2) { resultsEl.innerHTML = ''; return; }

  try {
    const snap = await getDocs(collection(db, 'productos'));
    const matches = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p =>
        p.name?.toLowerCase().includes(q) ||
        p.brand?.toLowerCase().includes(q) ||
        p.section?.toLowerCase().includes(q)
      )
      .slice(0, 8);

    if (!matches.length) {
      resultsEl.innerHTML = `<p class="text-surface-400 text-sm text-center py-3">Sin resultados</p>`;
      return;
    }

    resultsEl.innerHTML = matches.map(p => `
      <div class="stock-item cursor-pointer hover:border-brand-500" data-id="${p.id}">
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-gray-800 truncate">${p.name}</p>
          <p class="text-xs text-gray-400 font-mono">${p.id} • ${p.brand || ''} • Stock: ${p.stock}</p>
        </div>
        <span class="text-brand-600 font-display font-bold text-sm whitespace-nowrap">${fmt(p.price)}</span>
        <button class="btn-primary text-xs px-2 py-1 ml-1">+</button>
      </div>
    `).join('');

    resultsEl.querySelectorAll('[data-id]').forEach(el => {
      el.addEventListener('click', async () => {
        const found = matches.find(p => p.id === el.dataset.id);
        if (found) { addToCart(found); document.getElementById('searchProduct').value = ''; resultsEl.innerHTML = ''; }
      });
    });
  } catch (e) {
    console.error(e);
  }
});

// ════════════════════════════════════════════════════
//   CART LOGIC
// ════════════════════════════════════════════════════

function addToCart(product) {
  const existing = cart.find(i => i.id === product.id);
  if (existing) {
    if (existing.quantity >= product.stock) {
      toast(`Stock insuficiente para ${product.name}`, 'error');
      return;
    }
    existing.quantity++;
  } else {
    if (product.stock < 1) {
      toast(`${product.name} sin stock`, 'error');
      return;
    }
    cart.push({ ...product, quantity: 1, isCigarrillo: product.isCigarrillo || false });
  }
  renderCart();
  toast(`${product.name} agregado`, 'success');
}

function removeFromCart(id) {
  cart = cart.filter(i => i.id !== id);
  renderCart();
}

function updateCartQty(id, delta) {
  const item = cart.find(i => i.id === id);
  if (!item) return;
  const newQty = item.quantity + delta;
  if (newQty < 1) { removeFromCart(id); return; }
  if (newQty > item.stock) { toast('Sin stock suficiente', 'error'); return; }
  item.quantity = newQty;
  renderCart();
}

function renderCart() {
  const el    = document.getElementById('cartItems');
  const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const count = cart.reduce((s, i) => s + i.quantity, 0);

  document.getElementById('cartTotal').textContent    = fmt(total);
  document.getElementById('cartSubtotal').textContent = fmt(total);
  document.getElementById('cartCount').textContent    = count;
  document.getElementById('btnPagar').disabled        = cart.length === 0;

  if (!cart.length) {
    el.innerHTML = `<div class="text-center text-[#475569] py-10">
      <p class="text-4xl mb-2">🛒</p><p class="text-sm">El carrito está vacío</p></div>`;
    return;
  }

  el.innerHTML = cart.map(item => `
    <div class="cart-item" data-id="${item.id}">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-600 text-gray-800 truncate">
          ${item.isCigarrillo ? '' : item._isScale ? '⚖️ ' : ''}${item.name}
        </p>
        <p class="text-xs text-gray-500 font-mono">${item._isScale ? item._weightKg.toFixed(3)+' kg × '+fmt(item._pricePerKg)+'/kg' : fmt(item.price)+' c/u'}</p>
      </div>
      <div class="flex items-center gap-1.5">
        <button class="qty-btn w-6 h-6 rounded-md bg-[#232d45] hover:bg-[#2d3a54] text-white text-sm flex items-center justify-center"
                onclick="window._posUpdateQty('${item.id}', -1)">−</button>
        <span class="font-mono text-sm w-5 text-center">${item.quantity}</span>
        <button class="qty-btn w-6 h-6 rounded-md bg-[#232d45] hover:bg-[#2d3a54] text-white text-sm flex items-center justify-center"
                onclick="window._posUpdateQty('${item.id}', 1)">+</button>
      </div>
      <span class="font-display font-700 text-sm text-gray-800 ml-2 w-16 text-right">${fmt(item.price * item.quantity)}</span>
      <button class="ml-1 text-red-400 hover:text-red-300 text-xs" onclick="window._posRemove('${item.id}')">✕</button>
    </div>
  `).join('');
}

// Expose to inline onclick
window._posRemove    = removeFromCart;
window._posUpdateQty = updateCartQty;

document.getElementById('btnClearCart').addEventListener('click', () => {
  if (!cart.length) return;
  cart = [];
  renderCart();
  toast('Carrito vaciado', 'info');
});

// ════════════════════════════════════════════════════
//   PAYMENT MODAL
// ════════════════════════════════════════════════════

document.getElementById('btnPagar').addEventListener('click', () => {
  const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  document.getElementById('modalTotal').textContent = fmt(total);
  selectedMethod = null;

  document.querySelectorAll('.pay-method-btn').forEach(b => b.classList.remove('pay-method-selected'));
  document.getElementById('qrPagoContainer').classList.add('hidden');
  document.getElementById('efectivoInput').classList.add('hidden');
  document.getElementById('btnConfirmarPago').disabled = true;
  document.getElementById('montoEfectivo').value = '';
  document.getElementById('vuelto').textContent = '$0.00';

  openModal('modalPago');
});

document.querySelectorAll('.pay-method-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pay-method-btn').forEach(b => b.classList.remove('pay-method-selected'));
    btn.classList.add('pay-method-selected');
    selectedMethod = btn.dataset.method;

    document.getElementById('qrPagoContainer').classList.toggle('hidden', selectedMethod !== 'qr');
    document.getElementById('efectivoInput').classList.toggle('hidden', selectedMethod !== 'efectivo');
    document.getElementById('btnConfirmarPago').disabled = (selectedMethod === 'efectivo');
  });
});

document.getElementById('montoEfectivo').addEventListener('input', (e) => {
  const monto = parseFloat(e.target.value) || 0;
  const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const vuelto = monto - total;
  document.getElementById('vuelto').textContent = vuelto >= 0 ? fmt(vuelto) : '—';
  document.getElementById('btnConfirmarPago').disabled = vuelto < 0;
});

document.getElementById('closeModalPago').addEventListener('click', () => closeModal('modalPago'));

// ── Confirm Sale ─────────────────────────────────────
document.getElementById('btnConfirmarPago').addEventListener('click', async () => {
  if (!selectedMethod) return;
  const btn = document.getElementById('btnConfirmarPago');
  showLoading(btn, 'Procesando...');

  try {
    const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
    const saleId = `VTA-${Date.now()}`;

    // Run Firestore transaction: descuenta stock y guarda la venta
    // IMPORTANTE: Firestore requiere TODOS los reads antes de cualquier write
    // Items de balanza (_isScale) usan su _baseId para stock/ranking
    await runTransaction(db, async (tx) => {
      // ── FASE 1: todos los READS ──────────────────────
      // Para balanza: leer por _baseId; para normales: por id
      const prodRefs  = cart.map(item => doc(db, 'productos', item._isScale ? item._baseId : item.id));
      const rankRefs  = cart.map(item => doc(db, 'ranking',   item._isScale ? item._baseId : item.id));

      const prodSnaps = await Promise.all(prodRefs.map(r => tx.get(r)));
      const rankSnaps = await Promise.all(rankRefs.map(r => tx.get(r)));

      // Validar stock solo para productos normales (no balanza)
      for (let i = 0; i < cart.length; i++) {
        if (cart[i]._isScale) continue;
        if (!prodSnaps[i].exists()) throw new Error(`Producto "${cart[i].name}" no encontrado en inventario`);
        const currentStock = prodSnaps[i].data().stock;
        if (currentStock < cart[i].quantity) throw new Error(`Stock insuficiente para "${cart[i].name}" (disponible: ${currentStock})`);
      }

      // ── FASE 2: todos los WRITES ─────────────────────
      // 2a. Descontar stock solo en productos normales
      for (let i = 0; i < cart.length; i++) {
        if (cart[i]._isScale) continue;
        const currentStock = prodSnaps[i].data().stock;
        tx.update(prodRefs[i], { stock: currentStock - cart[i].quantity, updatedAt: serverTimestamp() });
      }

      // 2b. Guardar venta
      const totalCigarrillos = cart
        .filter(i => i.isCigarrillo)
        .reduce((s, i) => s + i.price * i.quantity, 0);

      const saleRef = doc(db, 'ventas', saleId);
      tx.set(saleRef, {
        id:        saleId,
        items:     cart.map(i => ({
          id:          i._isScale ? i._baseId : i.id,
          name:        i.name,
          price:       i.price,
          quantity:    i.quantity,
          isCigarrillo: i.isCigarrillo || false,
          isScale:     i._isScale || false,
        })),
        total,
        totalCigarrillos,
        method:    selectedMethod,
        date:      today(),
        timestamp: serverTimestamp(),
        cashier:   auth.currentUser?.email || 'desconocido',
      });

      // 2c. Actualizar ranking
      for (let i = 0; i < cart.length; i++) {
        const prev = rankSnaps[i].exists() ? rankSnaps[i].data().totalSold : 0;
        tx.set(rankRefs[i], {
          name:      cart[i].name,
          totalSold: prev + cart[i].quantity,
          lastSale:  serverTimestamp(),
        }, { merge: true });
      }
    });

    lastSaleData = { saleId, total, method: selectedMethod, items: [...cart], timestamp: new Date() };

    closeModal('modalPago');
    generateTicket(lastSaleData);
    openModal('modalTicket');

    cart = [];
    renderCart();
    toast('¡Venta registrada con éxito!', 'success');
  } catch (e) {
    toast(`Error: ${e.message}`, 'error');
    console.error(e);
  } finally {
    stopLoading(btn);
  }
});

// ════════════════════════════════════════════════════
//   TICKET GENERATION
// ════════════════════════════════════════════════════

function generateTicket(sale) {
  const now     = sale.timestamp.toLocaleString('es-AR');
  const methods = { efectivo: 'Efectivo', debito_credito: 'Débito/Crédito', transferencia: 'Transferencia', qr: 'QR/MercadoPago' };

  const itemRows = sale.items.map(i =>
    `<tr><td>${i.name}</td><td style="text-align:center">${i.quantity}</td>
     <td style="text-align:right">${fmt(i.price)}</td>
     <td style="text-align:right">${fmt(i.price * i.quantity)}</td></tr>`
  ).join('');

  document.getElementById('ticketContent').innerHTML = `
    <div style="text-align:center;margin-bottom:8px">
      <img src="logo.png" alt="Canocchi Store"
        style="width:64px;height:64px;object-fit:contain;margin:0 auto 6px;display:block"
        onerror="this.style.display='none'" />
      <strong style="font-size:1.1em">CANOCCHI STORE</strong><br/>
      <span style="font-size:0.75em">Stock and Pricing System V2.2.2.6</span>
    </div>
    <hr style="border-color:#ddd;margin:6px 0"/>
    <table style="width:100%;font-size:0.7em;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid #ddd">
        <th style="text-align:left">Producto</th>
        <th style="text-align:center">Cant</th>
        <th style="text-align:right">P.Unit</th>
        <th style="text-align:right">Subtotal</th>
      </tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    <hr style="border-color:#ddd;margin:6px 0"/>
    <div style="display:flex;justify-content:space-between;font-size:0.8em">
      <strong>TOTAL</strong>
      <strong>${fmt(sale.total)}</strong>
    </div>
    <div style="font-size:0.7em;color:#555;margin-top:4px">
      <div>Pago: ${methods[sale.method] || sale.method}</div>
      <div>N° Venta: ${sale.saleId}</div>
      <div>Fecha: ${now}</div>
      <div>Atendido por: ${auth.currentUser?.email || ''}</div>
    </div>
    <hr style="border-color:#ddd;margin:6px 0"/>
    <div style="text-align:center;font-size:0.65em;color:#777">
      ¡Gracias por su compra!<br/>Conserve este ticket
    </div>
  `;

  // Generate QR with sale data
  const qrContainer = document.getElementById('ticketQR');
  qrContainer.innerHTML = '';
  try {
    new QRCode(qrContainer, {
      text: JSON.stringify({ id: sale.saleId, total: sale.total, date: now, method: sale.method }),
      width: 120, height: 120,
      colorDark: '#000', colorLight: '#fff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch(e) { qrContainer.innerHTML = '<p class="text-xs text-gray-400">QR no disponible</p>'; }
}

document.getElementById('btnPrintTicket').addEventListener('click', () => {
  const content = document.getElementById('ticketContent').innerHTML;
  const w = window.open('', '_blank', 'width=400,height=600');
  w.document.write(`<!DOCTYPE html><html><head>
    <style>body{font-family:monospace;padding:1rem;font-size:12px}table{width:100%;border-collapse:collapse}</style>
    </head><body>${content}<script>window.onload=()=>{window.print();window.close()}</sc` + `ript></body></html>`);
  w.document.close();
});

document.getElementById('btnShareWhatsapp').addEventListener('click', () => {
  if (!lastSaleData) return;
  const methods = { efectivo: 'Efectivo', debito_credito: 'Débito/Crédito', transferencia: 'Transferencia', qr: 'QR/MercadoPago' };
  const now = lastSaleData.timestamp.toLocaleString('es-AR');
  const itemLines = lastSaleData.items
    .map(i => `• ${i.name} x${i.quantity} — ${fmt(i.price * i.quantity)}`)
    .join('\n');
  const msg =
`🛒 *CANOCCHI STORE*
📋 Ticket N° ${lastSaleData.saleId}
📅 ${now}

${itemLines}

━━━━━━━━━━━━━━
💰 *TOTAL: ${fmt(lastSaleData.total)}*
💳 Pago: ${methods[lastSaleData.method] || lastSaleData.method}
━━━━━━━━━━━━━━
¡Gracias por su compra! 🙌`;
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
});

document.getElementById('btnNuevaVenta').addEventListener('click', () => {
  closeModal('modalTicket');
  loadStockList();
  refocusBarcode(); // listo para el siguiente cliente
});

document.getElementById('closeModalTicket').addEventListener('click', () => closeModal('modalTicket'));

// ════════════════════════════════════════════════════
//   STOCK MANAGEMENT
// ════════════════════════════════════════════════════

document.getElementById('btnAddProduct').addEventListener('click', async () => {
  const barcode = document.getElementById('prodBarcode').value.trim();
  const name    = document.getElementById('prodName').value.trim();
  const section = document.getElementById('prodSection').value.trim();
  const brand   = document.getElementById('prodBrand').value.trim();
  const price   = parseFloat(document.getElementById('prodPrice').value);
  const stock   = parseInt(document.getElementById('prodStock').value);
  const isCigarrillo = document.getElementById('prodIsCigarrillo').checked;
  const isScale      = document.getElementById('prodIsScale').checked;
  const pricePerKg   = isScale ? (parseFloat(document.getElementById('prodPricePerKg').value) || 0) : 0;
  const msgEl   = document.getElementById('stockMsg');

  if (!barcode || !name || isNaN(price) || isNaN(stock)) {
    msgEl.textContent = '⚠️ Completá los campos obligatorios (*)';
    msgEl.className   = 'text-sm text-center text-yellow-400 font-mono';
    return;
  }

  const btn = document.getElementById('btnAddProduct');
  showLoading(btn, 'Guardando...');

  try {
    await setDoc(doc(db, 'productos', barcode), {
      name, section, brand, price, stock,
      barcode,
      isCigarrillo,
      isScale,
      pricePerKg: isScale ? pricePerKg : 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    msgEl.textContent = `✅ Producto "${name}" guardado correctamente`;
    msgEl.className   = 'text-sm text-center text-green-400 font-mono';

    // Clear form
    ['prodBarcode','prodName','prodSection','prodBrand','prodPrice','prodStock']
      .forEach(id => document.getElementById(id).value = '');
    document.getElementById('prodIsCigarrillo').checked = false;
    document.getElementById('prodIsScale').checked      = false;
    document.getElementById('prodPricePerKg').value     = '';
    document.getElementById('prodPricePerKgWrap').classList.add('hidden');

    loadStockList();
    toast(`Producto "${name}" guardado`, 'success');
  } catch (e) {
    msgEl.textContent = `❌ Error: ${e.message}`;
    msgEl.className   = 'text-sm text-center text-red-400 font-mono';
  } finally {
    stopLoading(btn);
  }
});

async function loadStockList(filter = '') {
  const el = document.getElementById('stockList');
  el.innerHTML = '<p class="text-[#475569] text-sm text-center py-8">Cargando...</p>';

  try {
    const snap = await getDocs(collection(db, 'productos'));
    let products = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (filter) {
      const f = filter.toLowerCase();
      products = products.filter(p =>
        p.name?.toLowerCase().includes(f) ||
        p.brand?.toLowerCase().includes(f) ||
        p.section?.toLowerCase().includes(f) ||
        p.id?.includes(f)
      );
    }

    products.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (!products.length) {
      el.innerHTML = '<p class="text-[#475569] text-sm text-center py-8">Sin productos</p>';
      return;
    }

    el.innerHTML = products.map(p => {
      const stockColor = p.stock <= 0 ? 'text-red-500' : p.stock < 5 ? 'text-yellow-600' : 'text-green-600';
      const rowClass   = p.stock <= 0 ? 'stock-item border-red-200 bg-red-50' : p.stock < 5 ? 'stock-item low-stock' : 'stock-item';
      return `
      <div class="${rowClass}" data-id="${p.id}">
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-gray-800 truncate">${p.name}</p>
          <p class="text-xs text-gray-400 font-mono">${p.id} · ${p.section || '—'} · ${p.brand || '—'}</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <!-- Precio editable inline -->
          <div class="flex items-center gap-1">
            <span class="text-xs text-gray-400 font-mono">$</span>
            <input id="price-val-${p.id}"
              type="number" step="0.01" value="${p.price}"
              class="font-mono font-bold text-sm text-brand-600 w-20 border border-transparent rounded px-1 py-0.5
                     hover:border-gray-300 focus:border-brand-500 focus:outline-none bg-transparent text-right"
              onchange="window._updatePrice('${p.id}', this.value)" />
          </div>
          <!-- Stock editable inline -->
          <div class="flex items-center gap-1 bg-gray-100 border border-gray-200 rounded-lg px-1.5 py-0.5">
            <button onclick="window._adjustStock('${p.id}', -1, ${p.stock})"
              class="w-5 h-5 flex items-center justify-center text-gray-500 hover:text-gray-800 text-base leading-none transition-colors font-bold">−</button>
            <span id="stock-val-${p.id}" class="font-mono text-sm w-6 text-center ${stockColor}">${p.stock}</span>
            <button onclick="window._adjustStock('${p.id}', 1, ${p.stock})"
              class="w-5 h-5 flex items-center justify-center text-gray-500 hover:text-gray-800 text-base leading-none transition-colors font-bold">+</button>
          </div>
          <!-- Eliminar -->
          <button onclick="window._deleteProduct('${p.id}', '${p.name.replace(/'/g, '')}')"
            class="w-6 h-6 flex items-center justify-center text-gray-300 hover:text-red-500 transition-colors text-sm font-bold ml-1">✕</button>
        </div>
      </div>
    `}).join('');
  } catch (e) {
    el.innerHTML = `<p class="text-red-400 text-sm text-center py-4">Error: ${e.message}</p>`;
  }
}

document.getElementById('filterStock').addEventListener('input', (e) => {
  loadStockList(e.target.value.trim());
});

// ════════════════════════════════════════════════════
//   DASHBOARD
// ════════════════════════════════════════════════════

async function loadDashboard() {
  // Stats for today
  try {
    const q    = query(collection(db, 'ventas'), where('date', '==', today()));
    const snap = await getDocs(q);
    const ventas = snap.docs.map(d => d.data());

    const totalHoy  = ventas.reduce((s, v) => s + (v.total || 0), 0);
    const txHoy     = ventas.length;
    const avgTicket = txHoy ? totalHoy / txHoy : 0;
    const totalCigarrillos = ventas.reduce((s, v) => s + (v.totalCigarrillos || 0), 0);

    document.getElementById('statSalesToday').textContent    = fmt(totalHoy);
    document.getElementById('statTxToday').textContent       = txHoy;
    document.getElementById('statAvgTicket').textContent     = fmt(avgTicket);
    document.getElementById('statCigarrillos').textContent   = fmt(totalCigarrillos);

    // Payment breakdown
    const byMethod = {};
    ventas.forEach(v => {
      byMethod[v.method] = (byMethod[v.method] || 0) + v.total;
    });

    const methodLabels = { efectivo: '💵 Efectivo', debito_credito: '💳 Débito/Crédito', transferencia: '🏦 Transferencia', qr: '📱 QR/MP' };
    const payEl = document.getElementById('paymentBreakdown');

    if (!Object.keys(byMethod).length) {
      payEl.innerHTML = '<p class="text-[#475569] text-sm text-center py-8">Sin ventas hoy</p>';
    } else {
      payEl.innerHTML = Object.entries(byMethod).map(([method, amount]) => `
        <div class="flex items-center justify-between p-3 bg-[#f8f8f8] rounded-xl border border-[#e5e5e5]">
          <span class="text-sm text-gray-700">${methodLabels[method] || method}</span>
          <span class="font-display font-700 text-brand-600">${fmt(amount)}</span>
        </div>
      `).join('');
    }
  } catch(e) { console.error(e); }

  // Top 5 ranking
  try {
    const q    = query(collection(db, 'ranking'), orderBy('totalSold', 'desc'), limit(5));
    const snap = await getDocs(q);
    const items = snap.docs.map((d, i) => ({ rank: i + 1, id: d.id, ...d.data() }));

    const maxSold = items[0]?.totalSold || 1;
    const el = document.getElementById('rankingList');

    if (!items.length) {
      el.innerHTML = '<p class="text-[#475569] text-sm text-center py-8">Sin datos de ventas aún</p>';
      return;
    }

    el.innerHTML = items.map(item => `
      <div class="rank-item">
        <div class="rank-badge rank-${item.rank <= 3 ? item.rank : 'other'}">${item.rank}</div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-600 text-gray-800 truncate">${item.name}</p>
          <div class="progress-bar mt-1">
            <div class="progress-fill" style="width:${(item.totalSold / maxSold * 100).toFixed(0)}%"></div>
          </div>
        </div>
        <div class="text-right">
          <p class="font-display font-700 text-brand-600">${item.totalSold}</p>
          <p class="text-xs text-gray-400">vendidos</p>
        </div>
      </div>
    `).join('');
  } catch(e) { console.error(e); }
}

document.getElementById('btnRefreshDashboard').addEventListener('click', loadDashboard);

// ════════════════════════════════════════════════════
//   CIERRE DE CAJA
// ════════════════════════════════════════════════════

let cierreData = null;

async function calculateCierre() {
  try {
    const q    = query(collection(db, 'ventas'), where('date', '==', today()));
    const snap = await getDocs(q);
    const ventas = snap.docs.map(d => d.data());

    const total = ventas.reduce((s, v) => s + (v.total || 0), 0);
    const tx    = ventas.length;
    const byMethod = { efectivo: 0, debito_credito: 0, transferencia: 0, qr: 0 };
    ventas.forEach(v => { if (v.method in byMethod) byMethod[v.method] += v.total; });
    const totalCigarrillos = ventas.reduce((s, v) => s + (v.totalCigarrillos || 0), 0);

    document.getElementById('cierreFecha').textContent       = new Date().toLocaleDateString('es-AR');
    document.getElementById('cTotal').textContent            = fmt(total);
    document.getElementById('cTx').textContent               = tx;
    document.getElementById('cEfectivo').textContent         = fmt(byMethod.efectivo);
    document.getElementById('cTarjeta').textContent          = fmt(byMethod.debito_credito);
    document.getElementById('cTransferencia').textContent    = fmt(byMethod.transferencia);
    document.getElementById('cQR').textContent               = fmt(byMethod.qr);
    document.getElementById('cCigarrillos').textContent      = fmt(totalCigarrillos);

    cierreData = { date: today(), total, tx, totalCigarrillos, ...byMethod };
  } catch(e) {
    toast('Error calculando cierre', 'error');
  }
}

document.getElementById('btnCalcularCierre').addEventListener('click', calculateCierre);

document.getElementById('btnGuardarCierre').addEventListener('click', async () => {
  if (!cierreData) { await calculateCierre(); }
  if (!cierreData) return;

  const btn = document.getElementById('btnGuardarCierre');
  showLoading(btn, 'Guardando...');
  const msgEl = document.getElementById('cierreMsg');

  // Leer monto caja fuerte ingresado manualmente
  const cajafuerteVal = parseFloat(document.getElementById('inputCajaFuerte').value) || 0;

  try {
    await setDoc(doc(db, 'cierres_caja', `${today()}_${Date.now()}`), {
      ...cierreData,
      cajaFuerte: cajafuerteVal,
      closedBy:  auth.currentUser?.email || 'sistema',
      closedAt:  serverTimestamp(),
    });
    msgEl.textContent = `✅ Cierre guardado — ${new Date().toLocaleTimeString('es-AR')}`;
    msgEl.className   = 'text-sm text-center text-green-400 font-mono';
    toast('Cierre de caja guardado', 'success');
    loadCierreHistorial();
    cierreData = null;
  } catch(e) {
    msgEl.textContent = `❌ Error: ${e.message}`;
    msgEl.className   = 'text-sm text-center text-red-400 font-mono';
  } finally {
    stopLoading(btn);
  }
});

async function loadCierreHistorial() {
  const el = document.getElementById('cierreHistorial');
  try {
    const q    = query(collection(db, 'cierres_caja'), orderBy('closedAt', 'desc'), limit(10));
    const snap = await getDocs(q);

    if (snap.empty) {
      el.innerHTML = '<p class="text-[#475569] text-sm text-center py-6">Sin cierres registrados</p>';
      return;
    }

    el.innerHTML = snap.docs.map(d => {
      const c = d.data();
      const ts = c.closedAt?.toDate ? c.closedAt.toDate().toLocaleString('es-AR') : c.date;
      return `
        <div class="cierre-item">
          <div class="flex justify-between items-center text-brand-600 mb-1 font-semibold">
            <span>${c.date}</span>
            <span>${fmt(c.total)}</span>
          </div>
          <div class="text-gray-600 text-xs space-y-0.5">
            <div class="flex justify-between"><span>Transacciones:</span><span>${c.tx}</span></div>
            <div class="flex justify-between"><span>Efectivo:</span><span class="text-green-700 font-semibold">${fmt(c.efectivo || 0)}</span></div>
            <div class="flex justify-between"><span>Tarjeta:</span><span class="text-blue-700 font-semibold">${fmt(c.debito_credito || 0)}</span></div>
            <div class="flex justify-between"><span>QR:</span><span class="text-yellow-700 font-semibold">${fmt(c.qr || 0)}</span></div>
            ${c.totalCigarrillos ? `<div class="flex justify-between border-t border-gray-200 pt-1 mt-1"><span>Cigarrillos:</span><span class="text-orange-600 font-semibold">${fmt(c.totalCigarrillos)}</span></div>` : ''}
            ${c.cajaFuerte ? `<div class="flex justify-between"><span>Caja Fuerte:</span><span class="text-indigo-700 font-semibold">${fmt(c.cajaFuerte)}</span></div>` : ''}
            <div class="text-gray-400 mt-1">${ts} · ${c.closedBy || ''}</div>
          </div>
        </div>
      `;
    }).join('');
  } catch(e) {
    el.innerHTML = `<p class="text-red-400 text-sm text-center py-4">Error: ${e.message}</p>`;
  }
}

// ════════════════════════════════════════════════════
//   MODAL HELPERS
// ════════════════════════════════════════════════════

function openModal(id) {
  const el = document.getElementById(id);
  el.classList.remove('hidden');
  el.classList.add('flex');
}
function closeModal(id) {
  const el = document.getElementById(id);
  el.classList.add('hidden');
  el.classList.remove('flex');
}

// Close on backdrop click
['modalPago', 'modalTicket'].forEach(id => {
  document.getElementById(id).addEventListener('click', (e) => {
    if (e.target.id === id) closeModal(id);
  });
});

// ── Update price inline ──────────────────────────────
window._updatePrice = async function(productId, newPriceStr) {
  const newPrice = parseFloat(newPriceStr);
  if (isNaN(newPrice) || newPrice < 0) return;
  try {
    await updateDoc(doc(db, 'productos', productId), {
      price: newPrice,
      updatedAt: serverTimestamp(),
    });
    toast('Precio actualizado', 'success');
  } catch (e) {
    toast(`Error al actualizar precio: ${e.message}`, 'error');
  }
};

// ── Delete product ────────────────────────────────────
window._deleteProduct = async function(productId, productName) {
  if (!confirm(`¿Eliminar "${productName}"? Esta acción no se puede deshacer.`)) return;
  try {
    const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    await deleteDoc(doc(db, 'productos', productId));
    toast(`"${productName}" eliminado`, 'info');
    loadStockList();
  } catch (e) {
    toast(`Error al eliminar: ${e.message}`, 'error');
  }
};

// ── Adjust stock inline ───────────────────────────────
window._adjustStock = async function(productId, delta, currentStock) {
  const newStock = Math.max(0, currentStock + delta);
  const spanEl   = document.getElementById(`stock-val-${productId}`);

  // Optimistic UI update
  if (spanEl) {
    spanEl.textContent = newStock;
    spanEl.className = `font-mono text-sm w-6 text-center ${newStock <= 0 ? 'text-red-500' : newStock < 5 ? 'text-yellow-600' : 'text-green-600'}`;
    // Update the onclick attributes of surrounding buttons
    const row = document.querySelector(`[data-id="${productId}"]`);
    if (row) {
      const [btnMinus, btnPlus] = row.querySelectorAll('button[onclick*="_adjustStock"]');
      if (btnMinus) btnMinus.setAttribute('onclick', `window._adjustStock('${productId}', -1, ${newStock})`);
      if (btnPlus)  btnPlus.setAttribute('onclick',  `window._adjustStock('${productId}', 1, ${newStock})`);
      // Update row color
      row.className = newStock <= 0
        ? 'stock-item border-red-200 bg-red-50'
        : newStock < 5 ? 'stock-item low-stock' : 'stock-item';
    }
  }

  try {
    await updateDoc(doc(db, 'productos', productId), {
      stock: newStock,
      updatedAt: serverTimestamp(),
    });
  } catch (e) {
    toast(`Error al actualizar stock: ${e.message}`, 'error');
    // Revert
    if (spanEl) spanEl.textContent = currentStock;
  }
};

// ── Export to Excel ───────────────────────────────────
async function exportStockToExcel() {
  try {
    const snap     = await getDocs(collection(db, 'productos'));
    const products = snap.docs.map(d => {
      const p = d.data();
      return {
        'Código de Barras': d.id,
        'Nombre':           p.name    || '',
        'Sección':          p.section || '',
        'Marca':            p.brand   || '',
        'Precio ($)':       p.price   ?? 0,
        'Stock':            p.stock   ?? 0,
        'Valor en Stock ($)': (p.price ?? 0) * (p.stock ?? 0),
      };
    });

    products.sort((a, b) => a['Nombre'].localeCompare(b['Nombre']));

    const ws = XLSX.utils.json_to_sheet(products);

    // Column widths
    ws['!cols'] = [
      { wch: 18 }, { wch: 32 }, { wch: 16 }, { wch: 16 },
      { wch: 12 }, { wch: 8  }, { wch: 18 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inventario');

    const fecha = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `inventario_canocchi_${fecha}.xlsx`);
    toast('✅ Excel exportado', 'success');
  } catch (e) {
    toast(`Error al exportar: ${e.message}`, 'error');
  }
}

document.getElementById('btnExportExcel').addEventListener('click', exportStockToExcel);

// ════════════════════════════════════════════════════
//   STOCK TAB — BARCODE SCANNER
// ════════════════════════════════════════════════════

let _stockCameraStream = null;
let _stockScanInterval = null;

async function startStockScanner() {
  if (stockScannerActive) return;
  const wrap     = document.getElementById('stock-qr-reader-wrap');
  const statusEl = document.getElementById('stockScanStatus');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
      }
    });

    _stockCameraStream = stream;
    stockScannerActive = true;
    wrap.classList.remove('hidden');

    document.getElementById('stock-qr-reader').innerHTML = `
      <div style="position:relative;width:100%;background:#000;border-radius:0.75rem;overflow:hidden;">
        <video id="stock-scanner-video" autoplay playsinline muted
          style="width:100%;display:block;max-height:200px;object-fit:cover;"></video>
        <canvas id="stock-scanner-canvas" style="display:none;"></canvas>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;">
          <div style="width:72%;height:40%;border:2.5px solid rgba(229,17,17,0.85);border-radius:8px;
                      box-shadow:0 0 0 9999px rgba(0,0,0,0.35);">
            <div style="position:absolute;top:-2px;left:-2px;width:16px;height:16px;
                        border-top:3px solid #fff;border-left:3px solid #fff;border-radius:3px 0 0 0;"></div>
            <div style="position:absolute;top:-2px;right:-2px;width:16px;height:16px;
                        border-top:3px solid #fff;border-right:3px solid #fff;border-radius:0 3px 0 0;"></div>
            <div style="position:absolute;bottom:-2px;left:-2px;width:16px;height:16px;
                        border-bottom:3px solid #fff;border-left:3px solid #fff;border-radius:0 0 0 3px;"></div>
            <div style="position:absolute;bottom:-2px;right:-2px;width:16px;height:16px;
                        border-bottom:3px solid #fff;border-right:3px solid #fff;border-radius:0 0 3px 0;"></div>
          </div>
        </div>
      </div>`;

    const video = document.getElementById('stock-scanner-video');
    video.srcObject = stream;

    // Esperar que el video esté listo
    await new Promise((resolve) => {
      if (video.readyState >= 2) { resolve(); return; }
      video.addEventListener('canplay', resolve, { once: true });
      setTimeout(resolve, 3000);
    });

    if (!stockScannerActive) return;

    const onCode = (code) => {
      playBeep();
      document.getElementById('prodBarcode').value = code;
      statusEl.textContent = `✅ Código: ${code}`;
      stopStockScanner();
      setTimeout(() => document.getElementById('prodName').focus(), 200);
    };

    // Intentar BarcodeDetector nativo primero
    const detector = await _initDetector();
    if (detector) {
      statusEl.textContent = 'Apuntá al código de barras';

      const loop = async () => {
        if (!stockScannerActive) return;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            const barcodes = await detector.detect(video);
            if (barcodes && barcodes.length && barcodes[0].rawValue) {
              onCode(barcodes[0].rawValue);
              return;
            }
          } catch(_) {}
        }
        _stockScanInterval = setTimeout(loop, 150);
      };
      loop();

    } else {
      // Fallback ZXing
      statusEl.textContent = 'Cargando lector…';
      await loadZXing();
      if (!stockScannerActive || !window.ZXing) {
        statusEl.textContent = 'Lector no disponible — ingresá el código manualmente';
        return;
      }
      statusEl.textContent = 'Apuntá al código de barras';
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
        ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8,
        ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.CODE_39,
        ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E,
        ZXing.BarcodeFormat.QR_CODE,
      ]);
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      const reader = new ZXing.MultiFormatReader();
      reader.setHints(hints);

      _stockScanInterval = setInterval(() => {
        if (!stockScannerActive || !video || video.readyState < 2) return;
        const canvas = document.getElementById('stock-scanner-canvas');
        if (!canvas) return;
        try {
          canvas.width  = video.videoWidth  || 640;
          canvas.height = video.videoHeight || 480;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imgData   = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const luminance = new ZXing.RGBLuminanceSource(imgData.data, canvas.width, canvas.height);
          const bitmap    = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));
          const result    = reader.decode(bitmap);
          if (result && result.getText()) {
            clearInterval(_stockScanInterval);
            _stockScanInterval = null;
            onCode(result.getText());
          }
        } catch(_) {}
      }, 250);
    }

  } catch (e) {
    wrap.classList.add('hidden');
    stockScannerActive = false;
    if (e.name === 'NotAllowedError') {
      toast('Permiso de cámara denegado', 'error');
    } else {
      toast(`Error de cámara: ${e.message || e}`, 'error');
    }
  }
}

async function stopStockScanner() {
  if (_stockCameraStream) {
    _stockCameraStream.getTracks().forEach(t => t.stop());
    _stockCameraStream = null;
  }
  if (_stockScanInterval !== null) {
    clearInterval(_stockScanInterval);
    clearTimeout(_stockScanInterval);
    _stockScanInterval = null;
  }
  stockScannerActive = false;
  stockHtml5QrCode   = null;
  document.getElementById('stock-qr-reader-wrap').classList.add('hidden');
}

document.getElementById('btnStockScan').addEventListener('click', startStockScanner);
document.getElementById('btnStockStopScan').addEventListener('click', stopStockScanner);

// ════════════════════════════════════════════════════
//   CAJA FUERTE
//   - Colección: caja_fuerte_movimientos
//   - Solo addDoc (nunca deleteDoc) → registros inmutables
//   - Campos: tipo, monto, descripcion, usuario, timestamp
// ════════════════════════════════════════════════════

let cfTipoActual = 'ingreso'; // 'ingreso' | 'egreso'

// ── Abrir modal ───────────────────────────────────────
function openCFModal(tipo) {
  cfTipoActual = tipo;
  const isIngreso = tipo === 'ingreso';

  document.getElementById('cfModalTitle').textContent =
    isIngreso ? 'Ingreso a Caja Fuerte' : 'Egreso de Caja Fuerte';

  const indicator = document.getElementById('cfModalIndicator');
  indicator.style.background = isIngreso ? '#16a34a' : '#e51111';

  const label = document.getElementById('cfModalTypeLabel');
  const svg   = indicator.querySelector('svg path');
  label.textContent = isIngreso ? 'INGRESO' : 'EGRESO';
  if (svg) svg.setAttribute('d', isIngreso
    ? 'M12 4v16m8-8H4'
    : 'M20 12H4');

  document.getElementById('cfMonto').value       = '';
  document.getElementById('cfDescripcion').value = '';
  document.getElementById('cfMsg').textContent   = '';

  openModal('modalCajaFuerte');
  setTimeout(() => document.getElementById('cfMonto').focus(), 100);
}

document.getElementById('btnCFIngreso').addEventListener('click', () => openCFModal('ingreso'));
document.getElementById('btnCFEgreso').addEventListener('click',  () => openCFModal('egreso'));
document.getElementById('closeModalCF').addEventListener('click', () => closeModal('modalCajaFuerte'));
document.getElementById('btnCancelCF').addEventListener('click',  () => closeModal('modalCajaFuerte'));

// ── Confirmar movimiento ──────────────────────────────
document.getElementById('btnConfirmCF').addEventListener('click', async () => {
  const monto      = parseFloat(document.getElementById('cfMonto').value);
  const descripcion = document.getElementById('cfDescripcion').value.trim();
  const msgEl      = document.getElementById('cfMsg');

  if (!monto || monto <= 0) {
    msgEl.textContent = 'Ingresá un monto válido mayor a cero';
    return;
  }
  if (!descripcion) {
    msgEl.textContent = 'Ingresá una descripción para el movimiento';
    return;
  }

  const btn = document.getElementById('btnConfirmCF');
  showLoading(btn, 'Guardando...');

  try {
    // addDoc siempre → nunca se sobreescribe ni elimina
    await addDoc(collection(db, 'caja_fuerte_movimientos'), {
      tipo:        cfTipoActual,          // 'ingreso' | 'egreso'
      monto:       cfTipoActual === 'ingreso' ? Math.abs(monto) : -Math.abs(monto),
      montoAbs:    Math.abs(monto),
      descripcion,
      usuario:     auth.currentUser?.email || 'sistema',
      timestamp:   serverTimestamp(),
      // Fecha/hora local legible (inmutable en el doc)
      fechaHora:   new Date().toLocaleString('es-AR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      }),
    });

    toast(
      `${cfTipoActual === 'ingreso' ? 'Ingreso' : 'Egreso'} registrado: $${monto.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`,
      'success'
    );
    closeModal('modalCajaFuerte');
    loadCajaFuerteHistorial();
  } catch(e) {
    msgEl.textContent = `Error: ${e.message}`;
  } finally {
    stopLoading(btn);
  }
});

// ── Cargar historial y balance ────────────────────────
async function loadCajaFuerteHistorial() {
  const el     = document.getElementById('cfHistorial');
  const balEl  = document.getElementById('cfBalance');
  if (!el || !balEl) return;

  try {
    const q    = query(
      collection(db, 'caja_fuerte_movimientos'),
      orderBy('timestamp', 'desc'),
      limit(100)
    );
    const snap = await getDocs(q);

    if (snap.empty) {
      el.innerHTML = '<p class="text-surface-400 text-sm text-center py-8">Sin movimientos registrados</p>';
      balEl.textContent = fmt(0);
      return;
    }

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Calcular balance (sumar todos los montos con signo)
    const balance = docs.reduce((s, d) => s + (d.monto || 0), 0);
    balEl.textContent = fmt(balance);
    balEl.style.color = balance >= 0 ? '#16a34a' : '#e51111';

    el.innerHTML = docs.map(d => {
      const isIngreso = d.tipo === 'ingreso';
      const ts = d.fechaHora || (d.timestamp?.toDate ? d.timestamp.toDate().toLocaleString('es-AR') : '—');
      return `
        <div class="flex items-center gap-3 p-3 rounded-xl border ${isIngreso ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800'}">
          <div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${isIngreso ? 'bg-green-600' : 'bg-brand-600'}">
            <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="${isIngreso ? 'M12 4v16m8-8H4' : 'M20 12H4'}"/>
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-gray-800 dark:text-white truncate">${d.descripcion}</p>
            <p class="text-xs text-gray-400 dark:text-gray-500 font-mono">${ts} · ${d.usuario || ''}</p>
          </div>
          <span class="font-display font-700 text-sm flex-shrink-0 ${isIngreso ? 'text-green-700' : 'text-brand-600'}">
            ${isIngreso ? '+' : '−'}${fmt(Math.abs(d.monto || d.montoAbs || 0))}
          </span>
        </div>
      `;
    }).join('');
  } catch(e) {
    el.innerHTML = `<p class="text-red-400 text-sm text-center py-4">Error: ${e.message}</p>`;
  }
}

// ════════════════════════════════════════════════════
//   INIT
// ════════════════════════════════════════════════════

function initApp() {
  renderCart();
  switchTab('pos');

  // Sync dark mode icons
  const isDark = document.documentElement.classList.contains('dark');
  const sun  = document.getElementById('iconSun');
  const moon = document.getElementById('iconMoon');
  if (sun)  sun.classList.toggle('hidden', !isDark);
  if (moon) moon.classList.toggle('hidden', isDark);

  // Pre-fill cierre date
  document.getElementById('cierreFecha').textContent = new Date().toLocaleDateString('es-AR');

  // Mostrar/ocultar campo precio por kg cuando se tilda balanza
  document.getElementById('prodIsScale').addEventListener('change', (e) => {
    document.getElementById('prodPricePerKgWrap').classList.toggle('hidden', !e.target.checked);
  });

  console.log('%c🛒 Canocchi POS — Sistema iniciado', 'color:#1a56e8;font-weight:bold;font-size:14px');
}

// ════════════════════════════════════════════════════
//   IMPORT FROM EXCEL
// ════════════════════════════════════════════════════

let importRows = []; // parsed & validated rows ready to upload

// Trigger file picker when import button is clicked
document.getElementById('btnImportExcel').addEventListener('click', () => {
  importRows = [];
  document.getElementById('importPreviewWrap').classList.add('hidden');
  document.getElementById('importFileName').classList.add('hidden');
  document.getElementById('importDropZone').classList.remove('hidden');
  document.getElementById('importErrorMsg').classList.add('hidden');
  document.getElementById('btnConfirmImport').disabled = true;
  document.getElementById('importProgress').textContent = '';
  document.getElementById('importExcelInput').value = '';
  openModal('modalImport');
});

document.getElementById('closeModalImport').addEventListener('click', () => closeModal('modalImport'));
document.getElementById('btnCancelImport').addEventListener('click', () => closeModal('modalImport'));

// Parse the file when user selects it
document.getElementById('importExcelInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  document.getElementById('importFileNameText').textContent = file.name;
  document.getElementById('importFileName').classList.remove('hidden');
  document.getElementById('importDropZone').classList.add('hidden');
  document.getElementById('importErrorMsg').classList.add('hidden');
  document.getElementById('btnConfirmImport').disabled = true;
  importRows = [];

  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const wb   = XLSX.read(ev.target.result, { type: 'binary' });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { defval: '' });

      if (!data.length) throw new Error('El archivo está vacío.');

      // Required columns
      const required = ['Código de Barras', 'Nombre', 'Precio ($)', 'Stock'];
      const headers  = Object.keys(data[0]);
      const missing  = required.filter(c => !headers.includes(c));
      if (missing.length) throw new Error(`Columnas faltantes: ${missing.join(', ')}`);

      // Validate & build rows
      const errors = [];
      importRows = [];

      data.forEach((row, i) => {
        const barcode = String(row['Código de Barras']).trim();
        const name    = String(row['Nombre']).trim();
        const price   = parseFloat(row['Precio ($)']);
        const stock   = parseInt(row['Stock']);

        if (!barcode || !name)         { errors.push(`Fila ${i+2}: código o nombre vacío`); return; }
        if (isNaN(price) || price < 0) { errors.push(`Fila ${i+2}: precio inválido`); return; }
        if (isNaN(stock) || stock < 0) { errors.push(`Fila ${i+2}: stock inválido`); return; }

        importRows.push({
          barcode,
          name,
          section: String(row['Sección'] || '').trim(),
          brand:   String(row['Marca']   || '').trim(),
          price,
          stock,
        });
      });

      if (errors.length) {
        const errEl = document.getElementById('importErrorMsg');
        errEl.textContent = errors.slice(0, 5).join(' | ') + (errors.length > 5 ? ` … y ${errors.length - 5} más` : '');
        errEl.classList.remove('hidden');
      }

      // Show preview table
      const tbody = document.getElementById('importPreviewBody');
      tbody.innerHTML = importRows.slice(0, 50).map(r => `
        <tr class="hover:bg-gray-50">
          <td class="px-3 py-1.5 font-mono text-gray-500">${r.barcode}</td>
          <td class="px-3 py-1.5 text-gray-800 font-medium">${r.name}</td>
          <td class="px-3 py-1.5 text-right font-mono text-brand-600">${fmt(r.price)}</td>
          <td class="px-3 py-1.5 text-right font-mono ${r.stock <= 0 ? 'text-red-500' : r.stock < 5 ? 'text-yellow-600' : 'text-green-600'}">${r.stock}</td>
        </tr>
      `).join('');

      document.getElementById('importPreviewCount').textContent =
        `${importRows.length} producto${importRows.length !== 1 ? 's' : ''} listos para importar` +
        (importRows.length > 50 ? ' (mostrando los primeros 50)' : '');

      document.getElementById('importPreviewWrap').classList.remove('hidden');
      document.getElementById('btnConfirmImport').disabled = importRows.length === 0;

    } catch (err) {
      const errEl = document.getElementById('importErrorMsg');
      errEl.textContent = `❌ ${err.message}`;
      errEl.classList.remove('hidden');
      document.getElementById('importPreviewWrap').classList.add('hidden');
    }
  };
  reader.readAsBinaryString(file);
});

// Upload to Firestore in batches of 400 (Firestore max batch = 500)
document.getElementById('btnConfirmImport').addEventListener('click', async () => {
  if (!importRows.length) return;

  const btn      = document.getElementById('btnConfirmImport');
  const progress = document.getElementById('importProgress');
  btn.disabled   = true;
  btn.textContent = '⏳ Importando...';

  try {
    const { writeBatch } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");

    const BATCH_SIZE = 400;
    let uploaded = 0;

    for (let i = 0; i < importRows.length; i += BATCH_SIZE) {
      const chunk = importRows.slice(i, i + BATCH_SIZE);
      const batch = writeBatch(db);

      chunk.forEach(r => {
        const ref = doc(db, 'productos', r.barcode);
        batch.set(ref, {
          name:      r.name,
          section:   r.section,
          brand:     r.brand,
          price:     r.price,
          stock:     r.stock,
          barcode:   r.barcode,
          updatedAt: serverTimestamp(),
        }, { merge: true });
      });

      await batch.commit();
      uploaded += chunk.length;
      progress.textContent = `⏳ Guardando… ${uploaded} / ${importRows.length} productos`;
    }

    progress.textContent = `✅ ${uploaded} producto${uploaded !== 1 ? 's' : ''} importado${uploaded !== 1 ? 's' : ''} correctamente`;
    progress.className   = 'text-xs text-center font-mono mt-3 min-h-[16px] text-green-600';
    toast(`✅ ${uploaded} productos importados al inventario`, 'success');
    loadStockList();

    setTimeout(() => closeModal('modalImport'), 2200);

  } catch (err) {
    progress.textContent = `❌ Error: ${err.message}`;
    progress.className   = 'text-xs text-center font-mono mt-3 min-h-[16px] text-red-500';
    toast(`Error al importar: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = '✅ IMPORTAR AL SISTEMA';
  }
});
