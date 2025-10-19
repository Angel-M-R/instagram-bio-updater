require("dotenv").config();
const inquirer = require("inquirer");
const fs = require("fs/promises");
const path = require("path");
const { URL } = require("url");
const fetch = require("node-fetch");
const {
  IgApiClient,
  IgCheckpointError,
} = require("instagram-private-api");

const ig = new IgApiClient();
const prompt = inquirer.createPromptModule();

const futureQuotes = [
  "You can’t stop the future",
  "We don’t think about what the future will be, we create it",
  "Bringing the future closer to the present",
  "The future isn’t something to wait for, it’s smthing to build",
  "We don’t dream about tomorrow, we design it today",
  "Transforming ideas into the future we imagine",
  "The future begins the moment we decide to create it",
  "Making possible what doesn’t exist yet",
  "Every step we take redefines tomorrow",
  "Connecting the present with the future",
  "Innovating today for a better tomorrow",
  "The future is closer than you think",
  "The limit isn’t tomorrow, it’s not trying today"
];

const getRandomQuote = () => {
  return futureQuotes[Math.floor(Math.random() * futureQuotes.length)];
};

const OPENWEATHER_API_KEY =
  process.env.OPENWEATHER_API_KEY || "5972265dfd4f9792eb849bd85687cd90";
const WEATHER_LAT = Number(
  process.env.WEATHER_LAT ?? process.env.MADRID_LAT ?? 40.4168
);
const WEATHER_LON = Number(
  process.env.WEATHER_LON ?? process.env.MADRID_LON ?? -3.7038
);
const WEATHER_UNITS =
  process.env.WEATHER_UNITS ||
  process.env.OPENWEATHER_UNITS ||
  "metric";
const WEATHER_LANG =
  process.env.WEATHER_LANG || process.env.OPENWEATHER_LANG || "es";
const WEATHER_CACHE_TTL_MS = Number(
  process.env.WEATHER_CACHE_TTL_MS ?? 15 * 60 * 1000
);

const statusMap = {
  thunderstorm: "stormy",
  drizzle: "rainy",
  rain: "rainy",
  snow: "snowy",
  clear: "sunny",
  clouds: "cloudy",
  mist: "foggy",
  smoke: "hazy",
  haze: "hazy",
  dust: "dusty",
  fog: "foggy",
  sand: "dusty",
  ash: "ashy",
  squall: "windy",
  tornado: "tornado",
};

const statusEmoji = {
  stormy: "⛈️",
  rainy: "🌧️",
  snowy: "❄️",
  sunny: "☀️",
  cloudy: "☁️",
  foggy: "🌫️",
  windy: "💨",
  hazy: "🌁",
  dusty: "🌪️",
  ashy: "🌋",
  tornado: "🌪️",
  unknown: "❔",
};

const normalizeStatus = (value = "") => {
  if (!value) {
    return "unknown";
  }
  const normalized = value.toLowerCase();
  return statusMap[normalized] || normalized || "unknown";
};

const formatTemp = (value) =>
  Number.isFinite(value) ? `${Math.round(value)}°` : "--";

const formatWeatherLine = (label, summary) => {
  if (!summary) {
    const fallbackContent = `${label} -- / -- ${statusEmoji.unknown}`;
    return `| ${fallbackContent.padEnd(20, " ")}|`;
  }
  const max = formatTemp(summary.maxTemp);
  const min = formatTemp(summary.minTemp);
  const emoji = statusEmoji[summary.status] ?? statusEmoji.unknown;
  let content
  if(label === "Hoy"){
  content = `${label}⠀⠀⠀${max} / ${min} ${emoji}`;
  } else {
  content = `${label} ${max} / ${min} ${emoji}`;
  }
  return ` | ${content}⠀⠀⠀⠀|`;
};

const summarizeEntries = (entries) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }
  let minTemp = Infinity;
  let maxTemp = -Infinity;
  const statusCount = new Map();

  for (const item of entries) {
    const main = item.main ?? {};
    if (typeof main.temp_min === "number") {
      minTemp = Math.min(minTemp, main.temp_min);
    }
    if (typeof main.temp_max === "number") {
      maxTemp = Math.max(maxTemp, main.temp_max);
    }
    const primary = item.weather?.[0]?.main;
    if (primary) {
      const status = normalizeStatus(primary);
      statusCount.set(status, (statusCount.get(status) ?? 0) + 1);
    }
  }

  if (!Number.isFinite(minTemp) || !Number.isFinite(maxTemp)) {
    return null;
  }

  let dominantStatus = "unknown";
  let dominantCount = -1;
  for (const [status, count] of statusCount.entries()) {
    if (count > dominantCount) {
      dominantStatus = status;
      dominantCount = count;
    }
  }

  return {
    minTemp,
    maxTemp,
    status: dominantStatus,
  };
};

const summarizeForecast = (data) => {
  if (!data || !Array.isArray(data.list) || data.list.length === 0) {
    return { today: null, tomorrow: null };
  }

  const timezoneOffset = data.city?.timezone ?? 0;

  const toLocalDateKey = (unixSeconds) => {
    const adjusted = new Date((unixSeconds + timezoneOffset) * 1000);
    return adjusted.toISOString().slice(0, 10); // YYYY-MM-DD
  };

  const nowUtc = Math.floor(Date.now() / 1000);
  const todayKey = toLocalDateKey(nowUtc);
  const tomorrowKey = toLocalDateKey(nowUtc + 86400);

  const todayEntries = [];
  const tomorrowEntries = [];

  for (const item of data.list) {
    if (typeof item.dt !== "number") {
      continue;
    }
    const key = toLocalDateKey(item.dt);
    if (key === todayKey) {
      todayEntries.push(item);
    } else if (key === tomorrowKey) {
      tomorrowEntries.push(item);
    }
  }

  return {
    today: summarizeEntries(todayEntries),
    tomorrow: summarizeEntries(tomorrowEntries),
  };
};

let weatherCache = null;
let weatherCacheTimestamp = 0;
const fetchWeatherSummary = async () => {
  const now = Date.now();
  if (
    weatherCache &&
    now - weatherCacheTimestamp < WEATHER_CACHE_TTL_MS
  ) {
    return weatherCache;
  }
  if (!OPENWEATHER_API_KEY) {
    throw new Error("Missing OPENWEATHER_API_KEY.");
  }

  const params = new URLSearchParams({
    lat: WEATHER_LAT.toString(),
    lon: WEATHER_LON.toString(),
    appid: OPENWEATHER_API_KEY,
    units: WEATHER_UNITS,
    lang: WEATHER_LANG,
  });

  const url = `https://api.openweathermap.org/data/2.5/forecast?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenWeather request failed (${response.status}): ${body}`
    );
  }

  const json = await response.json();
  const summary = summarizeForecast(json);
  weatherCache = summary;
  weatherCacheTimestamp = now;
  return summary;
};

let genAIClientPromise = null;
const ensureGenAIClient = async () => {
  if (!PROFILE_GENAI_PROMPT) {
    return null;
  }

  if (genAIClientPromise) {
    return genAIClientPromise;
  }

  const apiKey =
    process.env.GENAI_API_KEY ||
    process.env.GOOGLE_GENAI_API_KEY ||
    DEFAULT_GENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Google GenAI API key missing. Set GENAI_API_KEY or GOOGLE_GENAI_API_KEY."
    );
  }

  genAIClientPromise = import("@google/genai").then(
    ({ GoogleGenAI }) => new GoogleGenAI({ apiKey })
  );

  return genAIClientPromise;
};

const guessMimeType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
};

const generateProfileImageWithGenAI = async () => {
  if (!PROFILE_GENAI_PROMPT) {
    return null;
  }

  let baseImageBuffer;
  const baseImagePath = path.resolve(PROFILE_GENAI_SOURCE);
  try {
    baseImageBuffer = await fs.readFile(baseImagePath);
  } catch (error) {
    throw new Error(
      `Unable to read base profile image at ${baseImagePath}: ${
        error.message ?? error
      }`
    );
  }

  const client = await ensureGenAIClient();
  if (!client) {
    return null;
  }

  const base64Image = baseImageBuffer.toString("base64");
  const mimeType = guessMimeType(baseImagePath);

  const prompt = [
    { text: PROFILE_GENAI_PROMPT },
    {
      inlineData: {
        mimeType,
        data: base64Image,
      },
    },
  ];

  const response = await client.models.generateContent({
    model: PROFILE_GENAI_MODEL,
    contents: prompt,
    generationConfig: {
      responseMimeType: PROFILE_GENAI_RESPONSE_MIME,
    },
  });

  console.log(
    "GenAI response candidates:",
    JSON.stringify(response.candidates ?? [], null, 2)
  );

  const candidate = response.candidates?.[0];
  if (!candidate) {
    throw new Error("GenAI returned no candidates for profile image.");
  }

  const parts = candidate.content?.parts ?? [];
  if (!parts.length) {
    console.warn(
      "GenAI response contained no content parts.",
      "Finish reason:",
      candidate.finishReason,
      "Safety ratings:",
      candidate.safetyRatings
    );
    return null;
  }

  const imagePart = parts.find((part) => {
    if (!part.inlineData) {
      return false;
    }
    const modality = part.modality
      ? String(part.modality).toUpperCase()
      : "IMAGE";
    return modality === "IMAGE";
  });

  if (!imagePart) {
    console.warn(
      "GenAI response did not include inline image data.",
      "Finish reason:",
      candidate.finishReason,
      "Safety ratings:",
      candidate.safetyRatings
    );
    return null;
  }

  const imagesDir = path.resolve(PROFILE_GENAI_OUTPUT_DIR);
  await fs.mkdir(imagesDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(imagesDir, `profile-${timestamp}.png`);

  await fs.writeFile(
    outputPath,
    Buffer.from(imagePart.inlineData.data, "base64")
  );
  console.log(`Generated AI profile image at ${outputPath}`);
  return outputPath;
};

const buildBiography = async () => {
  const quote = getRandomQuote();
  const now = new Date();
  const madridDate = now.toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
  });
  let weatherTodayLine = formatWeatherLine("Hoy", null);
  let weatherTomorrowLine = formatWeatherLine("Mañana", null);

  try {
    const summary = await fetchWeatherSummary();
    if (summary?.today) {
      weatherTodayLine = formatWeatherLine("Hoy", summary.today);
    }
    if (summary?.tomorrow) {
      weatherTomorrowLine = formatWeatherLine("Mañana", summary.tomorrow);
    }
  } catch (weatherError) {
    console.warn(
      "Weather summary unavailable:",
      weatherError.message ?? weatherError
    );
  }

  return `${quote}\n+-----📍Madrid ${madridDate}📍-----+\n${weatherTodayLine}\n${weatherTomorrowLine}`;
};

const updateProfilePhotoIfNeeded = async () => {
  let targetPath = PROFILE_PHOTO_PATH
    ? path.resolve(PROFILE_PHOTO_PATH)
    : null;

  if (!targetPath && PROFILE_GENAI_PROMPT) {
    try {
      targetPath = await generateProfileImageWithGenAI();
    } catch (error) {
      console.warn(
        "AI profile image generation failed:",
        error.message ?? error
      );
      targetPath = null;
    }
  }

  if (!targetPath) {
    return false;
  }

  try {
    const imageBuffer = await fs.readFile(targetPath);
    await ig.account.changeProfilePicture(imageBuffer);
    console.log(`Profile photo updated using ${targetPath}.`);
    return true;
  } catch (error) {
    console.warn(
      "Failed to update profile photo:",
      error.message ?? error
    );
    return false;
  }
};
const USERNAME = process.env.IG_USERNAME;
const PASSWORD = process.env.IG_PASSWORD;
const PROXY = process.env.IG_PROXY?.trim();
const STATE_PATH = path.resolve(__dirname, "state.json");
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_LOGIN_ATTEMPTS = Number(process.env.MAX_LOGIN_ATTEMPTS ?? 5);
const TELEGRAM_WAIT_TIMEOUT_MS = Number(
  process.env.TELEGRAM_WAIT_TIMEOUT_MS ?? 10 * 60 * 1000
);
const TELEGRAM_POLL_TIMEOUT_SECONDS = Number(
  process.env.TELEGRAM_POLL_TIMEOUT_SECONDS ?? 25
);
const PROFILE_PHOTO_PATH = process.env.IG_PROFILE_PHOTO_PATH?.trim();
const DEFAULT_GENAI_API_KEY = "AIzaSyCGzzB-12I9hRw6DJnghJl6wMVWGc1iTMQ";
const PROFILE_GENAI_PROMPT =
  "Using the provided image, please change the bulb from the top to something random original";
const PROFILE_GENAI_SOURCE =
  process.env.IG_PROFILE_GENAI_SOURCE || "angelImage.jpg";
const PROFILE_GENAI_MODEL =
  process.env.IG_PROFILE_GENAI_MODEL || "gemini-2.5-flash-image";
const PROFILE_GENAI_OUTPUT_DIR =
  process.env.IG_PROFILE_GENAI_OUTPUT_DIR || "images";
const PROFILE_GENAI_RESPONSE_MIME =
  process.env.IG_PROFILE_GENAI_RESPONSE_MIME || "image/png";
const usingTelegram = Boolean(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID);
const telegramBaseUrl = TELEGRAM_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}`
  : null;
const TELEGRAM_CHAT_ID_STRING = TELEGRAM_CHAT_ID
  ? TELEGRAM_CHAT_ID.toString()
  : null;
const TELEGRAM_STOP_PATTERN = /^(stop|cancel|abort|quit|exit)$/i;
let telegramInitialized = false;
let telegramUpdateOffset = 0;

if (!USERNAME || !PASSWORD) {
  throw new Error(
    "Missing IG_USERNAME or IG_PASSWORD environment variables."
  );
}

ig.state.generateDevice(USERNAME);

const configureProxy = () => {
  if (!PROXY) {
    return;
  }

  if (PROXY.startsWith("http://") || PROXY.startsWith("https://")) {
    ig.state.proxyUrl = PROXY;
    console.log(`Routing API calls through HTTP proxy ${PROXY}`);
    return;
  }

  if (
    PROXY.startsWith("socks://") ||
    PROXY.startsWith("socks4://") ||
    PROXY.startsWith("socks4a://") ||
    PROXY.startsWith("socks5://") ||
    PROXY.startsWith("socks5h://")
  ) {
    let SocksProxyAgent;
    try {
      ({ SocksProxyAgent } = require("socks-proxy-agent"));
    } catch (socksError) {
      throw new Error(
        "IG_PROXY points to a SOCKS proxy but socks-proxy-agent is not installed. Run `npm install socks-proxy-agent`."
      );
    }

    const proxyUrl = new URL(PROXY);
    ig.request.defaults.agentClass = SocksProxyAgent;
    ig.request.defaults.agentOptions = {
      hostname: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 1080,
      protocol: proxyUrl.protocol,
    };

    if (proxyUrl.username || proxyUrl.password) {
      ig.request.defaults.agentOptions.userId = decodeURIComponent(
        proxyUrl.username
      );
      ig.request.defaults.agentOptions.password = decodeURIComponent(
        proxyUrl.password
      );
    }

    console.log(`Routing API calls through SOCKS proxy ${PROXY}`);
    return;
  }

  console.warn(
    `Unrecognized IG_PROXY scheme for value "${PROXY}". Expected http(s):// or socks://.`
  );
};

const loadSavedState = async () => {
  try {
    const rawState = await fs.readFile(STATE_PATH, "utf8");
    const parsedState = JSON.parse(rawState);
    await ig.state.deserialize(parsedState);
    console.log("Loaded saved Instagram session from state.json.");
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("No saved Instagram session found. Proceeding with login.");
      return;
    }

    console.warn(
      "Failed to load saved Instagram session. Proceeding with login.",
      error.message ?? error
    );
  }
};

const saveState = async () => {
  try {
    const state = await ig.state.serialize();
    await fs.writeFile(STATE_PATH, JSON.stringify(state));
    console.log("Saved Instagram session to state.json.");
  } catch (error) {
    console.warn(
      "Unable to persist Instagram session state:",
      error.message ?? error
    );
  }
};

const tryExistingSession = async () => {
  try {
    const user = await ig.account.currentUser();
    console.log(`Reusing existing session for ${user.username}.`);
    return user;
  } catch (error) {
    if (error?.response?.statusCode === 401) {
      console.log("Stored session expired. Logging in again.");
      return null;
    }
    console.warn(
      "Existing session validation failed. Logging in again.",
      error.message ?? error
    );
    return null;
  }
};

const schedulePostLoginFlow = () => {
  process.nextTick(async () => {
    try {
      await ig.simulate.postLoginFlow();
    } catch (logoutError) {
      console.warn("Post login flow failed:", logoutError.message);
    }
  });
};

const promptManualChallenge = async (challengeUrl) => {
  const webChallengeUrl = `https://www.instagram.com/challenge/?next=${encodeURIComponent(
    "/"
  )}`;
  console.log(
    "Instagram locked this login. Complete the challenge in your browser or the Instagram app."
  );
  console.log(`Mobile challenge URL: ${challengeUrl}`);
  console.log(
    `If that link does not load, visit: ${webChallengeUrl} (make sure you're logged into Instagram).`
  );
  if (usingTelegram) {
    const confirmed = await waitForManualChallengeConfirmation(challengeUrl);
    if (confirmed) {
      console.log("Received Telegram confirmation to retry login.");
      return;
    }
    console.warn(
      "Timed out waiting for Telegram confirmation. Falling back to terminal prompt."
    );
  }
  await prompt([
    {
      type: "input",
      name: "manualChallengeComplete",
      message:
        "After approving the login, press enter here to retry (leave blank and press enter).",
    },
  ]);
};

const sendTelegramNotification = async (message) => {
  if (!usingTelegram) {
    return;
  }

  try {
    const response = await fetch(`${telegramBaseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.warn("Failed to send Telegram alert:", errorBody);
    }
  } catch (telegramError) {
    console.warn(
      "Telegram notification failed:",
      telegramError.message ?? telegramError
    );
  }
};

const initializeTelegramUpdates = async () => {
  if (!usingTelegram || telegramInitialized) {
    return;
  }

  try {
    const response = await fetch(
      `${telegramBaseUrl}/getUpdates?timeout=0&offset=${telegramUpdateOffset}`
    );
    const data = await response.json();
    if (data.ok && Array.isArray(data.result) && data.result.length > 0) {
      telegramUpdateOffset =
        data.result[data.result.length - 1].update_id + 1;
    }
  } catch (error) {
    console.warn(
      "Failed to initialize Telegram updates:",
      error.message ?? error
    );
  } finally {
    telegramInitialized = true;
  }
};

const fetchTelegramUpdates = async (
  timeoutSeconds = TELEGRAM_POLL_TIMEOUT_SECONDS
) => {
  if (!usingTelegram) {
    return [];
  }

  await initializeTelegramUpdates();

  const params = new URLSearchParams({
    timeout: String(timeoutSeconds),
  });
  if (telegramUpdateOffset) {
    params.set("offset", String(telegramUpdateOffset));
  }

  try {
    const response = await fetch(
      `${telegramBaseUrl}/getUpdates?${params.toString()}`
    );
    const data = await response.json();

    if (!data.ok || !Array.isArray(data.result)) {
      console.warn(
        "Telegram getUpdates returned an unexpected response:",
        JSON.stringify(data)
      );
      return [];
    }

    if (data.result.length > 0) {
      telegramUpdateOffset =
        data.result[data.result.length - 1].update_id + 1;
    }

    return data.result;
  } catch (error) {
    console.warn(
      "Failed to fetch Telegram updates:",
      error.message ?? error
    );
    return [];
  }
};

const waitForTelegramResponse = async ({
  evaluate,
  timeoutMs = TELEGRAM_WAIT_TIMEOUT_MS,
}) => {
  if (!usingTelegram) {
    return null;
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const updates = await fetchTelegramUpdates();
    for (const update of updates) {
      const message =
        update.message ??
        update.edited_message ??
        update.callback_query?.message ??
        null;

      if (!message) {
        continue;
      }

      const chatId = message.chat?.id ?? update.callback_query?.message?.chat?.id;
      if (String(chatId) !== TELEGRAM_CHAT_ID_STRING) {
        continue;
      }

      if (message.from?.is_bot) {
        continue;
      }

      const text =
        (message.text ??
          update.callback_query?.data ??
          update.message?.caption ??
          "")
          .toString()
          .trim();

      if (!text) {
        continue;
      }

      if (TELEGRAM_STOP_PATTERN.test(text)) {
        throw new Error("Received stop command via Telegram.");
      }

      const result = evaluate(text, update);
      if (result !== undefined && result !== null && result !== false) {
        return {
          text,
          update,
          value: result === true ? text : result,
        };
      }
    }
  }

  return null;
};

const waitForManualChallengeConfirmation = async (challengeUrl) => {
  if (!usingTelegram) {
    return false;
  }

  const instructions = [
    "Instagram locked this login.",
    `Complete the challenge: ${challengeUrl}`,
    "Reply with *done* when you’ve approved it.",
  ].join("\n");

  await sendTelegramNotification(instructions);

  const confirmation = await waitForTelegramResponse({
    evaluate: (text) => (/^(done|approved|ok|yes)$/i.test(text) ? true : false),
  });

  return Boolean(confirmation);
};

const waitForSecurityCode = async () => {
  if (!usingTelegram) {
    return null;
  }

  await sendTelegramNotification(
    "Instagram sent a security code. Reply with the numeric code to continue."
  );

  const response = await waitForTelegramResponse({
    evaluate: (text) => {
      const digits = text.replace(/\D/g, "");
      if (digits.length >= 4 && digits.length <= 8) {
        return digits;
      }
      return false;
    },
  });

  if (!response?.value) {
    return null;
  }

  console.log("Received security code via Telegram.");
  return response.value;
};

const chooseVerificationMethod = async (methodChoices, defaultChoice) => {
  if (!usingTelegram || methodChoices.length === 0) {
    return null;
  }

  const formattedChoices = methodChoices
    .map((choice, index) => `${index + 1}. ${choice.name}`)
    .join("\n");

  await sendTelegramNotification(
    `Select Instagram verification method:\n${formattedChoices}\nReply with the option number or name.`
  );

  const response = await waitForTelegramResponse({
    evaluate: (text) => {
      const normalized = text.trim().toLowerCase();
      const numeric = Number.parseInt(normalized, 10);

      if (
        Number.isInteger(numeric) &&
        numeric >= 1 &&
        numeric <= methodChoices.length
      ) {
        return methodChoices[numeric - 1].value;
      }

      const directMatch = methodChoices.find((choice) => {
        const valueMatch =
          choice.value?.toLowerCase?.() === normalized ||
          choice.name?.toLowerCase?.() === normalized;
        return Boolean(valueMatch);
      });

      return directMatch?.value ?? false;
    },
  });

  if (response?.value) {
    console.log(
      `Selected verification method via Telegram: ${response.value}`
    );
    return response.value;
  }

  return defaultChoice ?? null;
};

const login = async (attempt = 1) => {
  if (attempt > MAX_LOGIN_ATTEMPTS) {
    throw new Error("Exceeded maximum checkpoint resolution attempts.");
  }

  if (attempt === 1) {
    await ig.simulate.preLoginFlow();
  }

  try {
    return await ig.account.login(USERNAME, PASSWORD);
  } catch (error) {
    if (error?.response?.body) {
      console.error(
        "Login error response:",
        JSON.stringify(error.response.body, null, 2)
      );
    }
    if (!(error instanceof IgCheckpointError)) {
      throw error;
    }

    console.log("Checkpoint required. Attempting automatic resolution...");
    const checkpoint = error.response?.body;
    console.log(
      "Raw checkpoint payload:",
      JSON.stringify(checkpoint, null, 2)
    );
    sendTelegramNotification(
      `⚠️ Instagram checkpoint for ${USERNAME}.\nChallenge: ${checkpoint.challenge?.url ?? "unknown"}`
    ).catch((notifyError) =>
      console.warn(
        "Background Telegram notification failed:",
        notifyError.message ?? notifyError
      )
    );

    if (!checkpoint?.challenge?.api_path) {
      throw new Error(
        "Instagram returned a checkpoint without challenge details."
      );
    }

    ig.state.checkpoint = checkpoint;
    const challengeUrl = checkpoint.challenge.url;
    const challengeLocked = Boolean(checkpoint.challenge.lock);

    let challengeState;
    try {
      challengeState = await ig.challenge.auto();
      console.log(
        "Challenge auto response:",
        JSON.stringify(challengeState, null, 2)
      );
    } catch (autoError) {
      if (autoError?.name === "IgNoCheckpointError") {
        await promptManualChallenge(challengeUrl);
        return login(attempt);
      }
      console.warn(
        "Automatic challenge initiation failed:",
        autoError.message ?? autoError
      );
      ig.state.checkpoint = checkpoint;
    }

    if (!challengeState) {
      try {
        challengeState = await ig.challenge.state();
      } catch (stateError) {
        if (stateError?.name === "IgNoCheckpointError") {
          await promptManualChallenge(challengeUrl);
          return login(attempt);
        }
        throw stateError;
      }
    }

    console.log(
      "Challenge state:",
      JSON.stringify(challengeState, null, 2)
    );

    if (challengeState.step_name === "select_verify_method") {
      const stepData = challengeState.step_data ?? {};
      const methodChoices =
        Array.isArray(stepData.choices) && stepData.choices.length > 0
          ? stepData.choices.map(([value, label]) => ({
              name: label ?? String(value),
              value: String(value),
            }))
          : stepData.choice
          ? [
              {
                name:
                  stepData.choice_label ??
                  `Option ${String(stepData.choice)}`,
                value: String(stepData.choice),
              },
            ]
          : [];

      let selectedMethod =
        stepData.default_choice ?? methodChoices[0]?.value ?? null;

      if (methodChoices.length > 1) {
        const telegramSelection = await chooseVerificationMethod(
          methodChoices,
          selectedMethod
        );

        if (telegramSelection) {
          selectedMethod = telegramSelection;
        } else {
          ({ selectedMethod } = await prompt([
            {
              type: "list",
              name: "selectedMethod",
              message: "Select verification method:",
              choices: methodChoices,
              default: selectedMethod ?? undefined,
            },
          ]));
        }
      }

      if (!selectedMethod) {
        throw new Error(
          "No verification methods presented by Instagram challenge."
        );
      }

      challengeState = await ig.challenge.selectVerifyMethod(selectedMethod);
    } else if (challengeState.step_name === "delta_login_review") {
      // Approve the login attempt automatically.
      challengeState = await ig.challenge.deltaLoginReview("0");
    }

    if (challengeState.action === "close") {
      if (challengeLocked) {
        await promptManualChallenge(challengeUrl);
        return login(attempt);
      }

      console.log("Challenge closed. Retrying login...");
      return login(attempt + 1);
    }

    if (challengeState.step_name !== "verify_code") {
      console.log(
        "Unable to reach SMS/Email verification step automatically. Challenge details:",
        JSON.stringify(challengeState, null, 2)
      );
      throw new Error(
        "Automatic challenge flow did not reach a verification code step."
      );
    }

    let code = await waitForSecurityCode();
    if (!code) {
      const response = await prompt([
        {
          type: "input",
          name: "code",
          message: "Enter the security code sent by Instagram:",
        },
      ]);
      code = response.code.trim();
    }

    const challengeResponse = await ig.challenge.sendSecurityCode(
      code.trim()
    );

    if (
      challengeResponse?.status === "ok" &&
      challengeResponse?.action === "close"
    ) {
      console.log("Security code accepted. Retrying login...");
    } else if (!challengeResponse?.logged_in_user) {
      console.log(
        "Unexpected challenge response:",
        JSON.stringify(challengeResponse, null, 2)
      );
    }

    return login(attempt + 1);
  }
};

(async () => {
  try {
    configureProxy();
    await loadSavedState();

    const existingSessionUser = await tryExistingSession();
    if (existingSessionUser) {
      console.log("Session validation succeeded. Skipping login.");
      schedulePostLoginFlow();
      await saveState();
      const biography = await buildBiography();
      await ig.account.setBiography(biography);
      console.log("Biography updated.");
      await updateProfilePhotoIfNeeded();
      return;
    }

    const authenticatedUser = await login();
    console.log(`Logged in as ${authenticatedUser.username}`);
    schedulePostLoginFlow();
    await saveState();

    const biography = await buildBiography();
    await ig.account.setBiography(biography);
    console.log("Biography updated.");
    await updateProfilePhotoIfNeeded();
  } catch (error) {
    console.error("Login failed:", error.message ?? error);
    if (
      usingTelegram &&
      error?.message === "Received stop command via Telegram."
    ) {
      await sendTelegramNotification("Instagram automation stopped as requested.");
    }
    process.exit(1);
  }
})();
