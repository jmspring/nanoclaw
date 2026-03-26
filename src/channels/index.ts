// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord

// gmail

// slack

// telegram (optional — requires grammy package)
import('./telegram.js').catch(() => {
  // grammy not installed — Telegram channel unavailable
});

// whatsapp
