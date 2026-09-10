const { Client } = require("whatsapp-web.js");

// WhatsApp can reload during authentication, invalidating Puppeteer's context.
// Retry injection in the existing browser so its navigation can finish.
class WhatsappClient extends Client {
  constructor(...args) {
    super(...args);
    this.monitoredBrowser = null;
    this.removeBrowserDisconnectMonitor = null;
    this.isDestroying = false;
  }

  async inject() {
    this.monitorBrowserDisconnect();
    return retryInjection(() => super.inject(), {
      canRetry: () => Boolean(this.pupPage && !this.pupPage.isClosed()),
    });
  }

  monitorBrowserDisconnect() {
    if (!this.pupBrowser || this.monitoredBrowser === this.pupBrowser) return;

    this.removeBrowserDisconnectMonitor?.();
    this.monitoredBrowser = this.pupBrowser;
    this.removeBrowserDisconnectMonitor = attachBrowserDisconnectMonitor(
      this.pupBrowser,
      () => {
        if (!this.isDestroying) {
          this.emit("disconnected", "BROWSER_DISCONNECTED");
        }
      }
    );
  }

  async destroy() {
    this.isDestroying = true;
    this.removeBrowserDisconnectMonitor?.();
    return super.destroy();
  }
}

function attachBrowserDisconnectMonitor(browser, onDisconnect) {
  let active = true;
  const handleDisconnect = () => {
    if (!active) return;
    active = false;
    onDisconnect();
  };

  browser.once("disconnected", handleDisconnect);
  return () => {
    active = false;
    browser.off?.("disconnected", handleDisconnect);
  };
}

async function retryInjection(inject, {
  canRetry = () => true,
  maxAttempts = 5,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  warn = (message) => console.warn(message),
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await inject();
    } catch (error) {
      const contextLost = /Execution context was destroyed|Cannot find context with specified id/i.test(
        String(error?.message || error)
      );
      if (!contextLost || attempt === maxAttempts || !canRetry()) throw error;
      warn(`[WhatsApp] Konteks halaman berubah; ulangi inisialisasi (${attempt}/${maxAttempts - 1}).`);
      await delay(1500 * attempt);
    }
  }
}

module.exports = {
  WhatsappClient,
  attachBrowserDisconnectMonitor,
  retryInjection,
};
