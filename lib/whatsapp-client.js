const { Client } = require("whatsapp-web.js");

// WhatsApp can reload during authentication, invalidating Puppeteer's context.
// Retry injection in the existing browser so its navigation can finish.
class WhatsappClient extends Client {
  async inject() {
    return retryInjection(() => super.inject(), {
      canRetry: () => Boolean(this.pupPage && !this.pupPage.isClosed()),
    });
  }
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

module.exports = { WhatsappClient, retryInjection };
