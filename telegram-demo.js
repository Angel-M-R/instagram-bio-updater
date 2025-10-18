require("dotenv").config();
const fetch = require("node-fetch");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_WAIT_TIMEOUT_MS = Number(
  process.env.TELEGRAM_WAIT_TIMEOUT_MS ?? 120000
);
const TELEGRAM_POLL_TIMEOUT_SECONDS = Number(
  process.env.TELEGRAM_POLL_TIMEOUT_SECONDS ?? 25
);
const MESSAGE =
  process.argv.slice(2).join(" ") ||
  "Demo: reply to this message to confirm bot polling.";

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error(
    "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment variables."
  );
  process.exit(1);
}

const telegramBaseUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
let updateOffset = 0;

const initializeUpdates = async () => {
  try {
    const response = await fetch(
      `${telegramBaseUrl}/getUpdates?timeout=0&offset=${updateOffset}`
    );
    const data = await response.json();
    if (data.ok && data.result.length > 0) {
      updateOffset = data.result[data.result.length - 1].update_id + 1;
    }
  } catch (error) {
    console.warn(
      "Failed to initialize Telegram updates:",
      error.message ?? error
    );
  }
};

const pollUpdates = async () => {
  const params = new URLSearchParams({
    timeout: String(TELEGRAM_POLL_TIMEOUT_SECONDS),
  });
  if (updateOffset) {
    params.set("offset", String(updateOffset));
  }

  const response = await fetch(
    `${telegramBaseUrl}/getUpdates?${params.toString()}`
  );
  const data = await response.json();

  if (!data.ok || !Array.isArray(data.result)) {
    console.warn(
      "Unexpected Telegram response while polling:",
      JSON.stringify(data)
    );
    return [];
  }

  if (data.result.length > 0) {
    updateOffset = data.result[data.result.length - 1].update_id + 1;
  }

  return data.result;
};

const waitForReply = async () => {
  const deadline = Date.now() + TELEGRAM_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const updates = await pollUpdates();
    for (const update of updates) {
      const message = update.message || update.edited_message;
      if (!message) {
        continue;
      }

      if (String(message.chat?.id) !== TELEGRAM_CHAT_ID) {
        continue;
      }

      if (message.from?.is_bot) {
        continue;
      }

      const text = (message.text || message.caption || "").trim();
      if (!text) {
        continue;
      }

      return { text, from: message.from };
    }
  }

  return null;
};

const sendMessage = async () => {
  const instructions = `${MESSAGE}\n\n(Reply with anything to confirm polling works.)`;

  const response = await fetch(`${telegramBaseUrl}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: instructions,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error("Failed to send message:", body);
    process.exit(1);
  }

  const data = await response.json();
  console.log("Message sent. Waiting for reply…");
  return data;
};

(async () => {
  try {
    await initializeUpdates();
    await sendMessage();

    const reply = await waitForReply();
    if (!reply) {
      console.log(
        `No reply received within ${Math.round(
          TELEGRAM_WAIT_TIMEOUT_MS / 1000
        )} seconds.`
      );
      process.exit(1);
    }

    console.log(
      `Received reply from ${reply.from.username || reply.from.first_name}: ${
        reply.text
      }`
    );
  } catch (error) {
    console.error("Error during Telegram demo:", error.message ?? error);
    process.exit(1);
  }
})();
