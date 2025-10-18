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
    lang: process.env.OPENWEATHER_LANG || "es",
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

const normalizeStatus = (main = "") => {
  const map = {
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
  return map[main.toLowerCase()] || main.toLowerCase() || "unknown";
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

const summarizeEntries = (entries, timezoneOffsetSeconds) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  let minTemp = Infinity;
  let maxTemp = -Infinity;
  const statusCount = new Map();

  for (const item of entries) {
    const main = item.main || {};
    if (typeof main.temp_min === "number") {
      minTemp = Math.min(minTemp, main.temp_min);
    }
    if (typeof main.temp_max === "number") {
      maxTemp = Math.max(maxTemp, main.temp_max);
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
  console.log(`Fetching weather from ${url}`);
  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OpenWeather request failed (${response.status}): ${text}`
    );
  }

  const json = await response.json();
  console.log("Weather response:");
  console.log(JSON.stringify(json, null, 2));

  if (ENDPOINT === "forecast") {
    const summary = summarizeForecast(json);
    console.log("\nSummary:");
    console.log(formatSummary("Today", summary.today));
    console.log(formatSummary("Tomorrow", summary.tomorrow));
  }
};

run().catch((error) => {
  console.error("Weather demo failed:", error.message ?? error);
  process.exit(1);
});
