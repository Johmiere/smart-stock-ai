"use strict";

function initPosCameraScanner({ isCheckoutLocked, isAdding, addBarcode }) {
  const get = (id) => document.getElementById("pc-camera-" + id);
  const start = get("start");
  const panel = get("panel");
  const status = get("status");
  const preview = get("preview");
  const video = get("video");
  const next = get("next");
  const retry = get("retry");
  const stop = get("stop");
  const device = get("device");
  const deviceField = get("device-field");
  const frameErrors = new Set(["NotFoundException", "ChecksumException", "FormatException"]);
  let camera = null;

  function barcodeReader() {
    const decoder = window.ZXingBrowser;
    const reader = new decoder.BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 250 });
    const format = decoder.BarcodeFormat;
    reader.possibleFormats = [format.EAN_13, format.EAN_8, format.UPC_A, format.UPC_E,
      format.CODE_128, format.CODE_39, format.CODE_93, format.ITF, format.CODABAR];
    return reader;
  }

  function barcodeValue(result) {
    const value = result.getText().trim();
    return /^[A-Za-z0-9_-]{3,50}$/.test(value) ? value : null;
  }

  function openPanel() {
    panel.hidden = false;
    start.setAttribute("aria-expanded", "true");
  }

  function announce(message, kind) {
    status.textContent = message;
    status.className = "notice" + (kind ? " " + kind : "");
  }

  function update() {
    const locked = isCheckoutLocked();
    start.disabled = Boolean(camera) || locked;
    device.disabled = locked || Boolean(camera?.opening || camera?.submitting);
    deviceField.hidden = !camera?.stream || device.options.length < 2;
    preview.hidden = !camera?.stream;
    next.hidden = !camera?.stream || camera.opening || Boolean(camera.capture || camera.barcode);
    next.disabled = locked || isAdding();
    retry.hidden = !camera?.barcode || camera.submitting;
    retry.disabled = locked || isAdding();
  }

  function isCurrent(opened) {
    return camera === opened && !isCheckoutLocked() && !document.hidden;
  }

  function stopScan(opened, loop) {
    const capture = opened.capture;
    opened.capture = null;
    (capture?.controls || loop)?.stop();
  }

  function stopStream(stream) {
    stream?.getTracks().forEach((track) => track.stop());
  }

  function releaseCamera() {
    const opened = camera;
    camera = null;
    if (opened) {
      stopScan(opened);
      stopStream(opened.stream);
    }
    video.srcObject = null;
    update();
  }

  function closeCamera() {
    releaseCamera();
    panel.hidden = true;
    start.setAttribute("aria-expanded", "false");
  }

  function showCameraError(error) {
    releaseCamera();
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
      announce("Allow camera access in your browser, or open Sales in Chrome or Edge.", "error");
    } else if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") {
      announce("No usable webcam found. Reconnect a webcam or choose Use scanner app.", "error");
    } else if (error?.name === "NotReadableError" || error?.name === "AbortError") {
      announce("Close other apps that are using the webcam and try again.", "error");
    } else {
      announce("Could not start the camera. Reopen it or enter the barcode in Sales.", "error");
    }
  }

  async function submitBarcode(opened) {
    if (!isCurrent(opened) || opened.submitting || !opened.barcode) return;
    if (isAdding()) {
      announce("Wait for the current item to finish, then choose Retry barcode.");
      update();
      return;
    }
    opened.submitting = true;
    announce("Looking up " + opened.barcode + "…");
    update();
    try {
      const result = await addBarcode(opened.barcode, 1, () => isCurrent(opened));
      if (!isCurrent(opened)) return;
      if (!result || result.retryable) {
        announce("Could not verify the barcode. Choose Retry barcode to look it up again.", "error");
        return;
      }
      opened.barcode = null;
      announce(result.success ? "Added one unit of " + result.message : result.message,
        result.success ? "success" : "error");
    } catch (_) {
      if (isCurrent(opened)) {
        opened.barcode = null;
        announce("Check the cart before scanning this barcode again.", "error");
      }
    } finally {
      opened.submitting = false;
      if (camera === opened) update();
    }
  }

  function scanNext() {
    const opened = camera;
    if (!opened?.stream || opened.opening || opened.capture || opened.barcode || !isCurrent(opened)) return;
    const capture = { controls: null };
    opened.capture = capture;
    announce("Point the webcam at one product barcode.");
    update();
    try {
      const reader = barcodeReader();
      const controls = reader.scan(video, (result, error, loop) => {
        if (opened.capture !== capture || !isCurrent(opened)) return;
        if (result) {
          stopScan(opened, loop);
          const barcode = barcodeValue(result);
          if (!barcode) {
            announce("Scan another barcode or enter the product code in Sales.", "error");
            update();
            return;
          }
          opened.barcode = barcode;
          void submitBarcode(opened);
        } else if (error && !frameErrors.has(error.getKind?.())) {
          stopScan(opened, loop);
          showCameraError(error);
        }
      });
      if (opened.capture === capture) capture.controls = controls;
    } catch (error) {
      if (isCurrent(opened)) showCameraError(error);
    }
  }

  async function startCamera(deviceId) {
    if (camera || isCheckoutLocked()) return;
    openPanel();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      announce("Camera access is unavailable here. Open this Sales page in Chrome or Edge, or enter the barcode.", "error");
      return;
    }
    if (!window.ZXingBrowser?.BrowserMultiFormatReader) {
      announce("The barcode reader did not load. Refresh Sales or enter the barcode.", "error");
      return;
    }
    const opened = { opening: true, stream: null, capture: null, barcode: null, submitting: false };
    camera = opened;
    announce("Opening webcam…");
    update();
    try {
      const constraints = { width: { ideal: 1280 } };
      if (deviceId) constraints.deviceId = { exact: deviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
      if (!isCurrent(opened)) {
        stopStream(stream);
        return;
      }
      opened.stream = stream;
      stream.getVideoTracks().forEach((track) => {
        track.addEventListener("ended", () => {
          if (camera === opened) {
            releaseCamera();
            announce("The webcam disconnected. Reconnect it and open the camera again.", "error");
          }
        }, { once: true });
      });
      video.srcObject = stream;
      video.muted = true;
      update();
      await video.play();
      if (!isCurrent(opened)) return;
      opened.opening = false;
      scanNext();
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (!isCurrent(opened)) return;
      const selected = stream.getVideoTracks()[0]?.getSettings().deviceId;
      device.replaceChildren(...devices.filter((item) => item.kind === "videoinput" && item.deviceId)
        .map((item, index) => new Option(item.label || "Camera " + (index + 1), item.deviceId)));
      if (selected) device.value = selected;
      update();
    } catch (error) {
      if (isCurrent(opened)) showCameraError(error);
    }
  }

  start.addEventListener("click", () => void startCamera());
  device.addEventListener("change", () => {
    const selected = device.value;
    releaseCamera();
    void startCamera(selected);
  });
  next.addEventListener("click", scanNext);
  retry.addEventListener("click", () => { if (camera) void submitBarcode(camera); });
  stop.addEventListener("click", () => {
    closeCamera();
    start.focus();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && camera) closeCamera();
  });
  window.addEventListener("pagehide", closeCamera);
  update();

  return { update, pauseForCheckout: closeCamera };
}
