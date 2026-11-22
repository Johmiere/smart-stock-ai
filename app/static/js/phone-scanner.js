(() => {
  "use strict";

  const secureLink = location.protocol === "https:" && window.isSecureContext;
  const storageKey = "smart-stock-phone-pairing";
  const incomingLink = Boolean(location.hash);
  const validToken = (value) => /^[A-Za-z0-9_-]{43}$/.test(value || "") ? value : null;
  let token = validToken(new URLSearchParams(location.hash.slice(1)).get("token"));
  if (secureLink) {
    try {
      if (incomingLink && token) sessionStorage.setItem(storageKey, token);
      else if (incomingLink) sessionStorage.removeItem(storageKey);
      else token = validToken(sessionStorage.getItem(storageKey));
    } catch (_) { /* Pairing still works when the browser blocks storage. */ }
  }
  if (incomingLink) history.replaceState(null, "", location.pathname + location.search);
  const get = (id) => document.getElementById("scanner-" + id);
  const connection = get("connection");
  const message = get("message");
  const connectButton = get("connect");
  const startButton = get("start");
  const nextButton = get("next");
  const stopButton = get("stop");
  const retryButton = get("retry");
  const preview = get("preview");
  const video = get("video");
  const cameraChoice = get("camera-choice");
  const cameraDevice = get("camera-device");
  const manual = get("manual");
  const barcodeInput = get("barcode");
  const sendButton = get("send");
  const availableCamera = Boolean(navigator.mediaDevices?.getUserMedia);
  let decoderLoading = null;
  const frameErrors = new Set(["NotFoundException", "ChecksumException", "FormatException"]);

  let connected = false;
  let ended = false;
  let connecting = false;
  let expiresAt = 0;
  let expirationTimer;
  let pendingScan = null;
  let sending = false;
  let cameraAttempt = 0;
  let openingCamera = false;
  let frameWait = null;
  let stream = null;
  let scanControls = null;
  let scanning = false;

  function announce(target, text, state) {
    target.textContent = text;
    target.dataset.state = state || "";
  }

  function updateControls() {
    connectButton.hidden = !token || !secureLink || connected || ended;
    connectButton.disabled = connecting;
    startButton.hidden = !connected || !availableCamera || Boolean(stream) || openingCamera;
    startButton.disabled = sending || Boolean(pendingScan);
    nextButton.hidden = !stream || scanning || openingCamera || Boolean(pendingScan);
    stopButton.hidden = !stream && !openingCamera;
    stopButton.textContent = openingCamera ? "Cancel camera" : "Stop camera";
    preview.hidden = !stream;
    cameraChoice.hidden = !stream || cameraDevice.options.length < 2;
    cameraDevice.disabled = openingCamera || sending || Boolean(pendingScan);
    retryButton.hidden = !connected || !pendingScan;
    retryButton.disabled = sending;
    manual.hidden = !connected;
    barcodeInput.disabled = sending || Boolean(pendingScan);
    sendButton.disabled = barcodeInput.disabled;
  }

  async function phoneRequest(path, payload) {
    const headers = { Authorization: "Bearer " + token };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const request = {
        method: "POST", headers, credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal
      };
      if (payload) {
        headers["Content-Type"] = "application/json";
        request.body = JSON.stringify(payload);
      }
      const response = await fetch("/api/scanner/phone/" + path, request);
      if (!response.ok) {
        const error = new Error("The scanner request was rejected.");
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function pauseScanning() {
    scanning = false;
    scanControls?.stop();
    scanControls = null;
  }

  function stopCamera() {
    cameraAttempt += 1;
    frameWait?.abort();
    openingCamera = false;
    pauseScanning();
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    updateControls();
  }

  function endPair(text) {
    clearTimeout(expirationTimer);
    if (pendingScan) {
      announce(message, "Check the register before sending that barcode again. The last send may have reached it.", "error");
    }
    connected = false;
    ended = true;
    try { sessionStorage.removeItem(storageKey); } catch (_) {}
    pendingScan = null;
    stopCamera();
    announce(connection, text, "error");
  }

  function pairEnded(error) {
    if (error.status === 401 || error.status === 404 || error.status === 410) {
      endPair("This scanner link has expired or the register disconnected it. Open a fresh link from Sales.");
      return true;
    }
    if (error.status === 400) {
      endPair("The scanner needs a trusted HTTPS connection. Open the HTTPS link from Sales.");
      return true;
    }
    return false;
  }

  async function connect() {
    if (connecting || connected || ended || !token || !secureLink) return;
    connecting = true;
    updateControls();
    announce(connection, "Connecting to the register…");
    try {
      const result = await phoneRequest("connect");
      if (!Number.isFinite(result?.expires_in) || result.expires_in <= 0) {
        throw new Error("The register did not confirm the scanner connection.");
      }
      connected = true;
      expiresAt = Date.now() + result.expires_in * 1000;
      expirationTimer = setTimeout(
        () => endPair("This scanner session expired. Open a fresh link from Sales."), result.expires_in * 1000
      );
      announce(connection, "Connected to the register.", "success");
      if (!availableCamera) {
        announce(message, "Open the trusted HTTPS link directly in Safari or Chrome to use the camera. You can still type a barcode below.", "error");
        manual.open = true;
      }
    } catch (error) {
      if (!pairEnded(error)) {
        announce(connection, "Could not reach the register. Check the connection and tap Reconnect.", "error");
      }
    } finally {
      connecting = false;
      updateControls();
    }
  }

  function scanId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }

  async function sendPending() {
    if (!pendingScan || sending || !connected) return;
    sending = true;
    updateControls();
    announce(message, "Sending " + pendingScan.barcode + "…");
    try {
      const result = await phoneRequest("scans", pendingScan);
      if (ended) return;
      if (result?.id == null) throw new Error("The register did not confirm the barcode.");
      announce(message, "Sent " + pendingScan.barcode + ". Check the register for the item.", "success");
      pendingScan = null;
      barcodeInput.value = "";
    } catch (error) {
      if (ended || pairEnded(error)) return;
      if (error.status === 409 || error.status === 413 || error.status === 422) {
        pendingScan = null;
        announce(message, "The register rejected this barcode. Scan again or check the code you typed.", "error");
      } else if (error.status === 429) {
        announce(message, "The register is busy. Wait a moment, then tap Retry sending barcode.", "error");
      } else {
        announce(message, "Delivery was interrupted. Tap Retry sending barcode to resend this scan safely.", "error");
      }
    } finally {
      sending = false;
      updateControls();
    }
  }

  function queueBarcode(value) {
    if (!connected || pendingScan || sending) return;
    const barcode = value.trim();
    if (!/^[A-Za-z0-9_-]{3,50}$/.test(barcode)) {
      announce(message, "Enter 3–50 letters, numbers, hyphens, or underscores.", "error");
      updateControls();
      return;
    }
    pauseScanning();
    // A retry keeps the original ID so a lost response cannot add the same scan again.
    pendingScan = { barcode, scan_id: scanId() };
    void sendPending();
  }

  function cameraError(error) {
    stopCamera();
    const errors = {
      NotAllowedError: "Camera permission was denied. Allow camera access for this site in your browser, then tap Start camera again.",
      NotFoundError: "No camera was found. Open the link directly in Chrome or Safari and try again.",
      NotReadableError: "The camera is busy. Close other camera apps and tap Start camera again.",
      OverconstrainedError: "This camera is unavailable. Tap Start camera to use the default rear camera.",
    };
    const detail = errors[error?.name] || "The camera did not provide a usable image. Tap Start camera to try again.";
    announce(message, detail, "error");
    manual.open = true;
  }

  function scanNext() {
    if (!connected || !stream || openingCamera || pendingScan || scanning) return;
    scanning = true;
    updateControls();
    announce(message, "Fit the whole barcode in the box. Move back slightly if the bars look blurry.");
    try {
      const decoder = window.ZXingBrowser;
      const reader = new decoder.BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 250 });
      const format = decoder.BarcodeFormat;
      reader.possibleFormats = [
        format.EAN_13, format.EAN_8, format.UPC_A, format.UPC_E,
        format.CODE_128, format.CODE_39, format.CODE_93, format.ITF, format.CODABAR
      ];
      const controls = reader.scan(video, (result, error, loop) => {
        if (!scanning) return;
        if (result) {
          loop.stop();
          scanControls = null;
          scanning = false;
          queueBarcode(result.getText());
        } else if (error && !frameErrors.has(error.getKind?.())) {
          loop.stop();
          cameraError(error);
        }
      });
      // The reader can find a barcode synchronously before returning the controls.
      if (scanning) scanControls = controls;
    } catch (error) {
      cameraError(error);
    }
  }

  function loadBarcodeReader() {
    if (window.ZXingBrowser?.BrowserMultiFormatReader) return Promise.resolve();
    if (decoderLoading) return decoderLoading;
    decoderLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/assets/js/vendor/zxing-browser.min.js";
      function fail() {
        clearTimeout(deadline);
        script.remove();
        reject(new Error("The barcode reader did not load"));
      }
      const deadline = setTimeout(fail, 12000);
      script.addEventListener("load", () => {
        clearTimeout(deadline);
        if (window.ZXingBrowser?.BrowserMultiFormatReader) resolve();
        else fail();
      }, { once: true });
      script.addEventListener("error", fail, { once: true });
      document.head.append(script);
    }).catch((error) => {
      decoderLoading = null;
      throw error;
    });
    return decoderLoading;
  }

  function waitForVideoFrame(signal) {
    if (video.videoWidth && video.videoHeight && video.readyState >= 2) return Promise.resolve(true);
    return new Promise((resolve) => {
      function finish(ready) {
        clearTimeout(timer);
        for (const event of events) video.removeEventListener(event, checkFrame);
        signal.removeEventListener("abort", abort);
        resolve(ready);
      }
      function checkFrame() {
        if (video.videoWidth && video.videoHeight && video.readyState >= 2) finish(true);
      }
      const abort = () => finish(false);
      const events = ["loadeddata", "canplay", "resize"];
      const timer = setTimeout(abort, 7000);
      for (const event of events) video.addEventListener(event, checkFrame);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async function startCamera(deviceId) {
    if (!connected || !availableCamera || openingCamera || stream || pendingScan) return;
    const attempt = ++cameraAttempt;
    openingCamera = true;
    updateControls();
    announce(message, "Opening camera…");
    try {
      const lens = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } };
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { ...lens, width: { ideal: 1280 } }
      });
      if (attempt !== cameraAttempt || document.hidden) {
        cameraStream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = cameraStream;
      stream.getVideoTracks().forEach((track) => {
        track.addEventListener("ended", () => {
          if (stream === cameraStream) cameraError();
        });
      });
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      updateControls();
      await video.play();
      if (attempt !== cameraAttempt) return;
      const waiting = new AbortController();
      frameWait = waiting;
      const ready = await waitForVideoFrame(waiting.signal);
      if (frameWait === waiting) frameWait = null;
      if (attempt !== cameraAttempt) return;
      if (!ready) throw new Error("Camera frames unavailable");
      announce(message, "Loading barcode reader…");
      try {
        await loadBarcodeReader();
      } catch (_) {
        if (attempt !== cameraAttempt) return;
        stopCamera();
        announce(message, "The barcode reader could not load. Tap Start camera to retry.", "error");
        return;
      }
      if (attempt !== cameraAttempt) return;
      openingCamera = false;
      scanNext();
      const inputs = await navigator.mediaDevices.enumerateDevices?.().catch(() => []) || [];
      if (attempt !== cameraAttempt) return;
      const activeDevice = cameraStream.getVideoTracks()[0]?.getSettings?.().deviceId;
      cameraDevice.replaceChildren(...inputs.filter((item) => item.kind === "videoinput" && item.deviceId)
        .map((item, index) => new Option(item.label || "Camera " + (index + 1), item.deviceId)));
      if (activeDevice) cameraDevice.value = activeDevice;
    } catch (error) {
      if (attempt === cameraAttempt) cameraError(error);
    } finally {
      if (attempt === cameraAttempt) {
        openingCamera = false;
        updateControls();
      }
    }
  }

  connectButton.addEventListener("click", connect);
  startButton.addEventListener("click", () => startCamera());
  cameraDevice.addEventListener("change", () => {
    const selected = cameraDevice.value;
    stopCamera();
    return startCamera(selected);
  });
  nextButton.addEventListener("click", scanNext);
  stopButton.addEventListener("click", () => {
    stopCamera();
    if (!pendingScan) announce(message, "Camera stopped.");
  });
  retryButton.addEventListener("click", sendPending);
  get("form").addEventListener("submit", (event) => {
    event.preventDefault();
    queueBarcode(barcodeInput.value);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && (stream || openingCamera)) {
      stopCamera();
      if (!pendingScan) announce(message, "The camera paused while this page was in the background.");
    } else if (connected && Date.now() >= expiresAt) {
      endPair("This scanner session expired. Open a fresh link from Sales.");
    }
  });
  addEventListener("pagehide", stopCamera);

  updateControls();
  if (!secureLink) {
    announce(connection, "Camera access needs trusted HTTPS. Use the store’s Smart Stock certificate and reopen the QR link in Chrome or Safari.", "error");
  } else if (!token) {
    announce(connection, "Open a fresh scanner link from Sales to connect to the register.");
  } else {
    void connect();
  }
})();
