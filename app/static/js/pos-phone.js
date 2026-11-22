function drawPairingCode(canvas, url) {
  if (typeof qrcode !== "function") return false;

  const code = qrcode(0, "M");
  code.addData(url);
  code.make();
  const modules = code.getModuleCount();
  const quietZone = 4;
  const scale = Math.max(3, Math.floor(240 / (modules + quietZone * 2)));
  const pixels = (modules + quietZone * 2) * scale;
  canvas.width = pixels;
  canvas.height = pixels;
  const context = canvas.getContext("2d");
  if (!context) return false;

  context.fillStyle = "#fff";
  context.fillRect(0, 0, pixels, pixels);
  context.fillStyle = "#000";
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (code.isDark(row, column)) {
        context.fillRect((column + quietZone) * scale, (row + quietZone) * scale, scale, scale);
      }
    }
  }
  return true;
}

function initPosPhoneScanner({ isCheckoutLocked, isAdding, addBarcode }) {
  const basePath = "/api/scanner/pairings";
  const start = document.getElementById("phone-scan-start");
  const panel = document.getElementById("phone-scan-panel");
  const status = document.getElementById("phone-scan-status");
  const pairing = document.getElementById("phone-scan-pairing");
  const instructions = document.getElementById("phone-scan-instructions");
  const canvas = document.getElementById("phone-scan-qr");
  const copy = document.getElementById("phone-scan-copy");
  const stop = document.getElementById("phone-scan-stop");
  const link = document.getElementById("phone-scan-link");
  const linkLabel = document.getElementById("phone-scan-link-label");
  const result = document.getElementById("phone-scan-result");
  let active = null;
  let opening = false;
  let generation = 0;
  let timer;
  let checkoutRevision = 0;
  let drainCheckoutScans = false;

  function setNotice(element, message, kind) {
    const className = "notice" + (kind ? " " + kind : "");
    if (element.textContent !== message) element.textContent = message;
    if (element.className !== className) element.className = className;
  }

  function showResult(message, kind) {
    result.hidden = !message;
    setNotice(result, message, kind);
  }

  function pathFor(session) {
    return basePath + "/" + encodeURIComponent(session.id);
  }

  function update() {
    start.disabled = opening || Boolean(active) || isCheckoutLocked();
  }

  function pauseForCheckout() {
    if (!active) return;
    checkoutRevision += 1;
    drainCheckoutScans = true;
    setNotice(status, "Checkout is in progress. Wait before scanning another item.");
  }

  function clearPairing() {
    const session = active;
    active = null;
    opening = false;
    generation += 1;
    clearTimeout(timer);
    pairing.hidden = true;
    link.hidden = true;
    linkLabel.hidden = true;
    link.value = "";
    canvas.width = 0;
    showResult("");
    update();
    return session;
  }

  async function poll(session) {
    if (active !== session) return;
    const startedLocked = isCheckoutLocked();
    const revision = checkoutRevision;
    const discardBatch = startedLocked || drainCheckoutScans;
    let delay = 800;
    try {
      const incoming = await api(pathFor(session) + "?after=" + session.after);
      if (active !== session) return;
      delay = incoming.phone_connected ? 800 : 1300;
      if (incoming.phone_connected && session.url) {
        // A cashier only needs to share the link until the phone joins.
        session.url = "";
        canvas.width = 0;
        canvas.hidden = true;
        instructions.hidden = true;
        copy.hidden = true;
        link.value = "";
        link.hidden = true;
        linkLabel.hidden = true;
      }
      if (isCheckoutLocked() || drainCheckoutScans) {
        setNotice(status, "Checkout is in progress. Wait before scanning another item.");
      } else if (incoming.phone_connected) {
        setNotice(status, "Phone paired. Scan an item on your phone.", "success");
      } else {
        setNotice(status, "Waiting for your phone to open the link.");
      }

      let skipped = 0;
      for (const scan of incoming.scans) {
        if (discardBatch || isCheckoutLocked() || checkoutRevision !== revision) {
          session.after = scan.id;
          skipped += 1;
          continue;
        }
        if (isAdding()) break;

        const outcome = await addBarcode(scan.barcode, 1, function () {
          return active === session && checkoutRevision === revision;
        });
        if (active !== session) return;
        if (!outcome) break;
        if (outcome.retryable) {
          showResult("Waiting to verify a phone scan. Check the store server connection.", "error");
          delay = 2300;
          break;
        }
        session.after = scan.id;
        showResult(outcome.success ? "Added one unit of " + outcome.message : outcome.message, outcome.success ? "success" : "error");
      }
      if (skipped) showResult("A phone scan arrived during checkout. Scan the item again when the cart is ready.", "error");
      if (drainCheckoutScans && !startedLocked && !isCheckoutLocked() && checkoutRevision === revision) {
        drainCheckoutScans = false;
        if (incoming.phone_connected) setNotice(status, "Phone paired. Scan an item on your phone.", "success");
        else setNotice(status, "Waiting for your phone to open the link.");
      }
    } catch (error) {
      if (active !== session) return;
      if (error.status === 404 || error.status === 401 || error.status === 403) {
        clearPairing();
        setNotice(status, "This phone link has ended. Pair your phone again to continue.");
        return;
      }
      setNotice(status, "Cannot check for phone scans. Trying again…", "error");
      delay = 2300;
    }
    if (active === session) timer = setTimeout(function () { poll(session); }, delay);
  }

  start.addEventListener("click", async function () {
    if (opening || active || isCheckoutLocked()) return;
    opening = true;
    const attempt = ++generation;
    start.setAttribute("aria-expanded", "true");
    panel.hidden = false;
    update();
    setNotice(status, "Creating your phone link…");

    try {
      const created = await api(basePath, { method: "POST" });
      const session = { id: created.pairing_id, url: created.phone_url, after: 0 };
      if (attempt !== generation) {
        await api(pathFor(session), { method: "DELETE" }).catch(function () {});
        return;
      }
      let qrAvailable = false;
      try {
        qrAvailable = drawPairingCode(canvas, session.url);
      } catch (_) {
        // The link also works when QR rendering is unavailable.
      }
      canvas.hidden = !qrAvailable;
      instructions.textContent = qrAvailable
        ? "Scan this QR code with your phone’s camera and open the link."
        : "Copy the scanner link and open it on your phone.";
      instructions.hidden = false;
      copy.hidden = false;
      link.value = session.url;
      pairing.hidden = false;
      active = session;
      drainCheckoutScans = isCheckoutLocked();
      setNotice(status, "Waiting for your phone to open the link.");
      poll(session);
    } catch (error) {
      if (attempt === generation) setNotice(status, error.message, "error");
    } finally {
      if (attempt === generation) {
        opening = false;
        update();
      }
    }
  });

  copy.addEventListener("click", async function () {
    const session = active;
    if (!session?.url) return;
    try {
      await navigator.clipboard.writeText(session.url);
      if (active === session && session.url) showResult("Scanner link copied.", "success");
    } catch (_) {
      if (active !== session || !session.url) return;
      link.hidden = false;
      linkLabel.hidden = false;
      link.focus();
      link.select();
      showResult("Copy the selected link and open it on your phone.");
    }
  });

  stop.addEventListener("click", async function () {
    const session = clearPairing();
    if (!session) return;
    const attempt = generation;
    setNotice(status, "Disconnecting your phone…");
    try {
      await api(pathFor(session), { method: "DELETE" });
      if (attempt === generation) setNotice(status, "Phone disconnected.");
    } catch (error) {
      if (attempt === generation) {
        if (error.status === 404) setNotice(status, "Phone disconnected.");
        else setNotice(status, "Scanning stopped on this POS. The phone link will expire automatically.", "error");
      }
    }
  });

  window.addEventListener("pagehide", function () {
    const session = clearPairing();
    if (!session) return;
    setNotice(status, "Pair your phone again to scan on this page.");
    if (csrfValue) {
      fetch(pathFor(session), {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": csrfValue },
        keepalive: true
      }).catch(function () {});
    }
  });

  return { pauseForCheckout, update };
}
