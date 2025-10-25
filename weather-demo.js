require("dotenv").config();
const fetch = require("node-fetch");

const API_KEY =
  process.env.OPENWEATHER_API_KEY || "dd832dac3748a202fa3152fc3411b45f";
const LATITUDE = Number(process.env.MADRID_LAT ?? 40.4168);
const LONGITUDE = Number(process.env.MADRID_LON ?? -3.7038);
const ENDPOINT =
  process.argv[2] ??
  process.env.OPENWEATHER_ENDPOINT ??
  "weather"; // accepted: weather, forecast

const buildUrl = () => {
  const params = new URLSearchParams({
    lat: LATITUDE.toString(),
    lon: LONGITUDE.toString(),
    appid: API_KEY,
    units: process.env.OPENWEATHER_UNITS || "metric",
    lang: process.env.OPENWEATHER_LANG || "en",
  });

  let path = "data/2.5/weather";
  if (ENDPOINT === "forecast") {
    path = "data/2.5/forecast";
  } else if (ENDPOINT !== "weather") {
    console.warn(
      `Unknown endpoint "${ENDPOINT}", falling back to current weather.`
    );
  }

  return `https://api.openweathermap.org/${path}?${params.toString()}`;
};

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

const normalizeStatus = (value = "") => {
  if (!value) {
    return "unknown";
  }
  // Handle case-insensitive matching for all documented OpenWeather conditions
  const normalized = value.toString().toLowerCase().trim();
  const mapped = statusMap[normalized];

  // Debug logging to see what we're receiving from the API
  if (!mapped) {
    console.log(`[Weather Debug] Unmapped status received: "${value}" (normalized: "${normalized}")`);
  }

  return mapped || normalized || "unknown";
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

// Priority order for weather conditions (higher = more important to show)
// We want to show rain/storms over clouds, even if clouds is more frequent
const weatherPriority = {
  tornado: 10,
  stormy: 9,
  snowy: 8,
  rainy: 7,
  windy: 6,
  ashy: 5,
  dusty: 4,
  foggy: 3,
  hazy: 3,
  cloudy: 2,
  sunny: 1,
  unknown: 0,
};

const summarizeEntries = (entries, timezoneOffsetSeconds) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  let minTemp = Infinity;
  let maxTemp = -Infinity;
  const statusCount = new Map();

  for (const item of entries) {
    const main = item.main || {};

    // Use the actual temp value for min/max calculation
    // temp_min/temp_max in the forecast API are city-wide reference values,
    // not daily extremes. We need to track actual temperatures.
    if (typeof main.temp === "number") {
      minTemp = Math.min(minTemp, main.temp);
      maxTemp = Math.max(maxTemp, main.temp);
    }

    const weatherMain = item.weather?.[0]?.main;
    if (weatherMain) {
      const normalized = normalizeStatus(weatherMain);
      statusCount.set(normalized, (statusCount.get(normalized) ?? 0) + 1);
    }
  }

  if (minTemp === Infinity || maxTemp === -Infinity) {
    return null;
  }

  // Select the most important weather status based on priority, not just frequency
  // This ensures rain shows up even if most hours are cloudy
  let selectedStatus = "unknown";
  let selectedPriority = -1;

  for (const [status, count] of statusCount.entries()) {
    const priority = weatherPriority[status] ?? 0;
    // Only consider statuses that actually occur
    if (count > 0 && priority > selectedPriority) {
      selectedStatus = status;
      selectedPriority = priority;
    }
  }

  // Debug logging to see weather status distribution
  console.log(`[Weather Debug] Status counts:`, Object.fromEntries(statusCount));
  console.log(`[Weather Debug] Selected status: "${selectedStatus}" (priority: ${selectedPriority})`);

  return {
    minTemp,
    maxTemp,
    status: selectedStatus,
  };
};

const summarizeForecast = (json) => {
  const timezoneOffset = json.city?.timezone ?? 0;
  const list = json.list ?? [];

  const toLocalDateKey = (unixSeconds) => {
    const local = new Date((unixSeconds + timezoneOffset) * 1000);
    return local.toISOString().slice(0, 10); // YYYY-MM-DD
  };

  const nowUtcSeconds = Math.floor(Date.now() / 1000);
  const todayKey = toLocalDateKey(nowUtcSeconds);
  const tomorrowKey = toLocalDateKey(nowUtcSeconds + 86400);

  const todayEntries = [];
  const tomorrowEntries = [];

  for (const item of list) {
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

  const todaySummary = summarizeEntries(todayEntries, timezoneOffset);
  const tomorrowSummary = summarizeEntries(tomorrowEntries, timezoneOffset);

  return {
    today: todaySummary,
    tomorrow: tomorrowSummary,
  };
};

const formatSummary = (label, summary) => {
  if (!summary) {
    return `${label}: no forecast data available.`;
  }
  const formatTemp = (value) => `${Math.round(value)}°C`;
  const emoji = statusEmoji[summary.status] ?? statusEmoji.unknown;
  return `${label}: min ${formatTemp(summary.minTemp)}, max ${formatTemp(
    summary.maxTemp
  )}, status ${summary.status} ${emoji}`;
};

const run = async () => {
  const url = buildUrl();
  console.log(`Fetching weather from ${url}\n`);
  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OpenWeather request failed (${response.status}): ${text}`
    );
  }

  const json = await response.json();

  if (ENDPOINT === "forecast") {
    const summary = summarizeForecast(json);
    console.log("\n=== Weather Summary ===");
    console.log(formatSummary("Today", summary.today));
    console.log(formatSummary("Tomorrow", summary.tomorrow));
  } else {
    // Current weather endpoint
    const weatherMain = json.weather?.[0]?.main;
    const temp = json.main?.temp;
    if (weatherMain && temp !== undefined) {
      const status = normalizeStatus(weatherMain);
      const emoji = statusEmoji[status] ?? statusEmoji.unknown;
      console.log(`\n=== Current Weather ===`);
      console.log(`Temperature: ${Math.round(temp)}°C`);
      console.log(`Status: ${status} ${emoji}`);
    }
  }
};

run().catch((error) => {
  console.error("Weather demo failed:", error.message ?? error);
  process.exit(1);
});
