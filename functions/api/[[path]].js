/**
 * Cloudflare Pages Function — 天气聚合 API
 *
 * 路由:
 *   GET /api/weather?lat=&lon=&name=   聚合天气（多源自动降级）
 *   GET /api/search?q=                 城市搜索
 *   GET /api/locate                    按来访 IP 定位
 *   GET /api/sources                   查看各数据源健康状态
 *
 * 数据源（全部免费、无需 Key、商用友好）:
 *   forecast:  open-meteo -> met.no -> wttr.in -> brightsky -> 7timer -> nws
 *   air:       open-meteo-air-quality
 *   geocode:   open-meteo-geocoding -> (fallback) local city table
 *
 * 每个源独立超时，任一失败自动切下一个；响应体 source 字段标明实际生效源。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const UA = 'cf-weather/1.0 (+https://github.com/)';

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      ...CORS,
      ...extra,
    },
  });

/** 带超时的 fetch */
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* WMO 天气代码 -> 统一图标 key + 中英文描述                             */
/* ------------------------------------------------------------------ */
const WMO_MAP = {
  0:  ['clear',        '晴',         'Clear sky'],
  1:  ['mostly-clear', '晴间多云',    'Mainly clear'],
  2:  ['partly-cloudy','多云',       'Partly cloudy'],
  3:  ['overcast',     '阴',         'Overcast'],
  45: ['fog',          '雾',         'Fog'],
  48: ['fog',          '雾凇',       'Depositing rime fog'],
  51: ['drizzle',      '小毛毛雨',    'Light drizzle'],
  53: ['drizzle',      '毛毛雨',      'Moderate drizzle'],
  55: ['drizzle',      '大毛毛雨',    'Dense drizzle'],
  56: ['sleet',        '冻毛毛雨',    'Light freezing drizzle'],
  57: ['sleet',        '强冻毛毛雨',  'Dense freezing drizzle'],
  61: ['rain',         '小雨',       'Slight rain'],
  63: ['rain',         '中雨',       'Moderate rain'],
  65: ['rain',         '大雨',       'Heavy rain'],
  66: ['sleet',        '冻雨',       'Light freezing rain'],
  67: ['sleet',        '强冻雨',      'Heavy freezing rain'],
  71: ['snow',         '小雪',       'Slight snow'],
  73: ['snow',         '中雪',       'Moderate snow'],
  75: ['snow',         '大雪',       'Heavy snow'],
  77: ['snow',         '米雪',       'Snow grains'],
  80: ['rain',         '小阵雨',      'Slight rain showers'],
  81: ['rain',         '阵雨',       'Moderate rain showers'],
  82: ['rain',         '强阵雨',      'Violent rain showers'],
  85: ['snow',         '小阵雪',      'Slight snow showers'],
  86: ['snow',         '大阵雪',      'Heavy snow showers'],
  95: ['thunder',      '雷阵雨',      'Thunderstorm'],
  96: ['thunder',      '雷阵雨伴冰雹','Thunderstorm with hail'],
  99: ['thunder',      '强雷暴伴冰雹','Thunderstorm with heavy hail'],
};

const describeWmo = (code) => {
  const hit = WMO_MAP[code];
  return hit
    ? { icon: hit[0], text: hit[1], textEn: hit[2] }
    : { icon: 'unknown', text: '未知', textEn: 'Unknown' };
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/** 风向角度 -> 中文方位 */
function windDir(deg) {
  if (!Number.isFinite(deg)) return '';
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return dirs[Math.round(deg / 45) % 8];
}

/* ================================================================== */
/* 源 1 — Open-Meteo (主源，功能最全)                                   */
/* ================================================================== */
async function srcOpenMeteo(lat, lon, name) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: [
      'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
      'is_day', 'precipitation', 'weather_code', 'cloud_cover',
      'pressure_msl', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
    ].join(','),
    hourly: ['temperature_2m', 'weather_code', 'precipitation_probability', 'is_day'].join(','),
    daily: [
      'weather_code', 'temperature_2m_max', 'temperature_2m_min',
      'sunrise', 'sunset', 'precipitation_probability_max',
      'uv_index_max', 'wind_speed_10m_max',
    ].join(','),
    timezone: 'auto',
    forecast_days: '7',
    forecast_hours: '24',
  });

  const res = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const d = await res.json();

  const c = d.current || {};
  const h = d.hourly || {};
  const dy = d.daily || {};
  const cur = describeWmo(c.weather_code);

  // 对齐到"当前时刻起 24 小时"
  const nowIso = (c.time || '').slice(0, 13); // YYYY-MM-DDTHH
  let start = (h.time || []).findIndex((t) => t.slice(0, 13) >= nowIso);
  if (start < 0) start = 0;

  const hourly = [];
  for (let i = start; i < (h.time || []).length && hourly.length < 24; i++) {
    hourly.push({
      time: h.time[i],
      temp: round(h.temperature_2m?.[i]),
      code: h.weather_code?.[i],
      pop: round(h.precipitation_probability?.[i]) ?? 0,
      isDay: h.is_day?.[i] ?? 1,
    });
  }

  const daily = [];
  for (let i = 0; i < (dy.time || []).length && daily.length < 7; i++) {
    daily.push({
      date: dy.time[i],
      code: dy.weather_code?.[i],
      max: round(dy.temperature_2m_max?.[i]),
      min: round(dy.temperature_2m_min?.[i]),
      pop: round(dy.precipitation_probability_max?.[i]) ?? 0,
      sunrise: dy.sunrise?.[i] || null,
      sunset: dy.sunset?.[i] || null,
      uv: round1(dy.uv_index_max?.[i]),
      windMax: round(dy.wind_speed_10m_max?.[i]),
    });
  }

  return {
    source: 'Open-Meteo',
    location: { name, lat: +lat, lon: +lon, timezone: d.timezone || 'auto' },
    current: {
      temp: round(c.temperature_2m),
      feelsLike: round(c.apparent_temperature),
      humidity: round(c.relative_humidity_2m),
      precip: round1(c.precipitation),
      code: c.weather_code,
      icon: cur.icon,
      text: cur.text,
      textEn: cur.textEn,
      cloud: round(c.cloud_cover),
      pressure: round(c.pressure_msl),
      wind: round1(c.wind_speed_10m),
      windGust: round1(c.wind_gusts_10m),
      windDir: windDir(c.wind_direction_10m),
      windDeg: round(c.wind_direction_10m),
      isDay: c.is_day ?? 1,
      observedAt: c.time,
    },
    hourly,
    daily,
    air: null, // 由聚合层补充
  };
}

/* ================================================================== */
/* 源 2 — met.no (挪威气象局，全球，官方)                               */
/* ================================================================== */
async function srcMetNo(lat, lon, name) {
  const res = await fetchWithTimeout(
    `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`,
    { headers: { 'User-Agent': UA } },
    9000
  );
  if (!res.ok) throw new Error(`met.no ${res.status}`);
  const d = await res.json();
  const ts = d.properties?.timeseries || [];
  if (!ts.length) throw new Error('met.no empty');

  const parseSym = (sym) => {
    const s = (sym || '').toLowerCase();
    if (s.includes('thunder')) return 'thunder';
    if (s.includes('sleet') || s.includes('freezing')) return 'sleet';
    if (s.includes('snow')) return 'snow';
    if (s.includes('rain') || s.includes('shower')) return 'rain';
    if (s.includes('drizzle')) return 'drizzle';
    if (s.includes('fog')) return 'fog';
    if (s.includes('cloudy') && s.includes('partly')) return 'partly-cloudy';
    if (s.includes('cloudy')) return 'overcast';
    if (s.includes('fair')) return 'mostly-clear';
    if (s.includes('clear')) return 'clear';
    return 'unknown';
  };
  const symText = (sym) => {
    const m = {
      clearsky: '晴', fair: '晴间多云', partlycloudy: '多云', cloudy: '阴',
      fog: '雾', lightrain: '小雨', rain: '中雨', heavyrain: '大雨',
      lightrainshowers: '小阵雨', rainshowers: '阵雨', heavyrainshowers: '强阵雨',
      lightsleet: '冻雨', sleet: '冻雨', snow: '雪', lightsnow: '小雪', heavysnow: '大雪',
      rainandthunder: '雷阵雨', rainshowersandthunder: '雷阵雨',
    };
    const key = (sym || '').toLowerCase().replace(/_/g, '').replace(/day|night|polartwilight/g, '');
    return m[key] || '多云';
  };

  const first = ts[0];
  const det = first.data.instant.details;

  const hourly = [];
  for (const t of ts.slice(0, 24)) {
    const n = t.data.next_1_hours || t.data.next_6_hours || {};
    const i = t.data.instant.details;
    const sym = n.summary?.symbol_code || '';
    hourly.push({
      time: t.time,
      temp: round(i.air_temperature),
      code: null,
      icon: parseSym(sym),
      pop: round(n.details?.probability_of_precipitation) ?? 0,
      isDay: (() => {
        const hh = new Date(t.time).getUTCHours();
        return hh >= 6 && hh < 18 ? 1 : 0;
      })(),
    });
  }

  // met.no 无逐日端点，按小时聚合出 7 天
  const byDay = new Map();
  for (const t of ts) {
    const day = t.time.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }
  const daily = [];
  for (const [day, list] of byDay) {
    if (daily.length >= 7) break;
    const temps = list.map((t) => t.data.instant.details.air_temperature);
    const syms = list
      .map((t) => (t.data.next_1_hours || t.data.next_6_hours)?.summary?.symbol_code)
      .filter(Boolean);
    const mid = syms[Math.floor(syms.length / 2)] || syms[0];
    daily.push({
      date: day,
      code: null,
      icon: parseSym(mid),
      text: symText(mid),
      max: round(Math.max(...temps)),
      min: round(Math.min(...temps)),
      pop: 0,
      sunrise: null,
      sunset: null,
      uv: null,
      windMax: null,
    });
  }

  const sym0 = (first.data.next_1_hours || first.data.next_6_hours)?.summary?.symbol_code;

  return {
    source: 'MET Norway',
    sourceNote: '挪威气象研究所 · 官方数据',
    location: { name, lat: +lat, lon: +lon, timezone: 'auto' },
    current: {
      temp: round(det.air_temperature),
      feelsLike: null,
      humidity: round(det.relative_humidity),
      precip: round1((first.data.next_1_hours?.details?.precipitation_amount) ?? null),
      code: null,
      icon: parseSym(sym0),
      text: symText(sym0),
      textEn: sym0 || '',
      cloud: round(det.cloud_area_fraction),
      pressure: round(det.air_pressure_at_sea_level),
      wind: round1(det.wind_speed),
      windGust: round1(det.wind_speed_of_gust),
      windDir: windDir(det.wind_from_direction),
      windDeg: round(det.wind_from_direction),
      isDay: (() => {
        const hh = new Date(first.time).getUTCHours();
        return hh >= 6 && hh < 18 ? 1 : 0;
      })(),
      observedAt: first.time,
    },
    hourly,
    daily,
    air: null,
  };
}

/* ================================================================== */
/* 源 3 — wttr.in (全球，覆盖广)                                        */
/* ================================================================== */
async function srcWttr(lat, lon, name) {
  const res = await fetchWithTimeout(
    `https://wttr.in/${lat},${lon}?format=j1`,
    { headers: { 'User-Agent': UA } },
    10000
  );
  if (!res.ok) throw new Error(`wttr ${res.status}`);
  const raw = await res.json();

  const cur = raw.current_condition?.[0] || {};
  const weather = raw.weather || [];
  const area = raw.nearest_area?.[0] || {};
  const resolvedName =
    name || area.areaName?.[0]?.value || '当前位置';

  const wcode = parseInt(cur.weatherCode ?? '0', 10);
  const wmap = {
    113: [0, 'clear'], 116: [2, 'partly-cloudy'], 119: [3, 'overcast'], 122: [3, 'overcast'],
    143: [45, 'fog'], 248: [45, 'fog'], 260: [45, 'fog'],
    176: [80, 'rain'], 263: [51, 'drizzle'], 266: [53, 'drizzle'], 293: [61, 'rain'],
    296: [61, 'rain'], 299: [63, 'rain'], 302: [63, 'rain'], 305: [65, 'rain'],
    308: [65, 'rain'], 311: [56, 'sleet'], 314: [57, 'sleet'], 353: [80, 'rain'], 356: [81, 'rain'],
    359: [82, 'rain'], 179: [71, 'snow'], 182: [73, 'snow'], 185: [56, 'sleet'], 227: [73, 'snow'],
    230: [75, 'snow'], 320: [73, 'snow'], 323: [71, 'snow'], 326: [71, 'snow'],
    329: [73, 'snow'], 332: [73, 'snow'], 335: [75, 'snow'], 338: [75, 'snow'],
    350: [77, 'snow'], 362: [85, 'snow'], 365: [86, 'snow'], 368: [85, 'snow'], 371: [86, 'snow'],
    386: [95, 'thunder'], 389: [95, 'thunder'], 392: [95, 'thunder'], 395: [95, 'thunder'],
  };
  const mapped = wmap[wcode] || [3, 'unknown'];
  const norm = describeWmo(mapped[0]);

  const hourly = [];
  for (let d = 0; d < weather.length && hourly.length < 24; d++) {
    for (const h of weather[d].hourly || []) {
      if (hourly.length >= 24) break;
      const hh = parseInt(h.time, 10) / 100;
      hourly.push({
        time: `${weather[d].date}T${String(hh).padStart(2, '0')}:00`,
        temp: round(parseFloat(h.tempC)),
        code: null,
        icon: norm.icon,
        pop: parseInt(h.chanceofrain || '0', 10),
        isDay: hh >= 6 && hh < 18 ? 1 : 0,
      });
    }
  }

  const daily = weather.slice(0, 7).map((d) => ({
    date: d.date,
    code: null,
    icon: describeWmo(parseInt(d.hourly?.[4]?.weatherCode ?? '116', 10)).icon,
    text: d.hourly?.[4]?.weatherDesc?.[0]?.value || '',
    max: round(parseFloat(d.maxtempC)),
    min: round(parseFloat(d.mintempC)),
    pop: parseInt(d.hourly?.[4]?.chanceofrain || '0', 10),
    sunrise: d.astronomy?.[0]?.sunrise || null,
    sunset: d.astronomy?.[0]?.sunset || null,
    uv: round1(parseFloat(d.uvIndex)),
    windMax: round(parseFloat(d.hourly?.[4]?.windspeedKmph ?? d.hourly?.[0]?.windspeedKmph)),
  }));

  return {
    source: 'wttr.in',
    location: { name: resolvedName, lat: +lat, lon: +lon, timezone: 'auto' },
    current: {
      temp: round(parseFloat(cur.temp_C)),
      feelsLike: round(parseFloat(cur.FeelsLikeC)),
      humidity: round(parseFloat(cur.humidity)),
      precip: round1(parseFloat(cur.precipMM)),
      code: mapped[0],
      icon: norm.icon,
      text: norm.text,
      textEn: norm.textEn,
      cloud: round(parseFloat(cur.cloudcover)),
      pressure: round(parseFloat(cur.pressure)),
      wind: round1(parseFloat(cur.windspeedKmph)),
      windGust: round1(parseFloat(cur.WindGustKmph)),
      windDir: cur.winddir16Point || windDir(parseFloat(cur.winddirDegree)),
      windDeg: round(parseFloat(cur.winddirDegree)),
      isDay: 1,
      observedAt: cur.localObsDateTime,
      windUnit: 'km/h',
    },
    hourly,
    daily,
    air: null,
  };
}

/* ================================================================== */
/* 源 4 — Bright Sky (德国气象局 DWD)                                   */
/* ================================================================== */
async function srcBrightSky(lat, lon, name) {
  // Bright Sky 按日期查询，显式使用 UTC 当天，避免 Worker 本地时区偏移
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const res = await fetchWithTimeout(
    `https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}&date=${dateStr}`,
    { headers: { 'User-Agent': UA } },
    9000
  );
  if (!res.ok) throw new Error(`brightsky ${res.status}`);
  const d = await res.json();
  const arr = (d.weather || []).filter((w) => w.temperature !== null);
  if (!arr.length) throw new Error('brightsky empty');

  const iconMap = {
    'clear-day': 'clear', 'clear-night': 'clear',
    'partly-cloudy-day': 'partly-cloudy', 'partly-cloudy-night': 'partly-cloudy',
    cloudy: 'overcast', fog: 'fog', wind: 'overcast',
    rain: 'rain', sleet: 'sleet', snow: 'snow', hail: 'thunder', thunderstorm: 'thunder',
  };
  const textMap = {
    'clear-day': '晴', 'clear-night': '晴', 'partly-cloudy-day': '多云',
    'partly-cloudy-night': '多云', cloudy: '阴', fog: '雾',
    rain: '雨', sleet: '雨夹雪', snow: '雪', hail: '冰雹', thunderstorm: '雷阵雨',
  };

  const cur = arr[arr.length - 1];
  const icon = iconMap[cur.icon] || 'unknown';

  const hourly = arr.slice(-24).map((w) => ({
    time: w.timestamp,
    temp: round(w.temperature),
    code: null,
    icon: iconMap[w.icon] || icon,
    pop: round(w.precipitation_probability) ?? 0,
    isDay: w.icon?.includes('day') ? 1 : 0,
  }));

  return {
    source: 'Bright Sky (DWD)',
    sourceNote: '德国气象局 · 官方数据',
    location: { name, lat: +lat, lon: +lon, timezone: 'auto' },
    current: {
      temp: round(cur.temperature),
      feelsLike: round(cur.apparent_temperature),
      humidity: round(cur.relative_humidity),
      precip: round1(cur.precipitation_60),
      code: null,
      icon,
      text: textMap[cur.icon] || '多云',
      textEn: cur.icon || '',
      cloud: round(cur.cloud_cover),
      pressure: round(cur.pressure_msl),
      wind: round1(cur.wind_speed_60),
      windGust: round1(cur.wind_gust_speed_60),
      windDir: windDir(cur.wind_direction_60),
      windDeg: round(cur.wind_direction_60),
      isDay: cur.icon?.includes('day') ? 1 : 0,
      observedAt: cur.timestamp,
    },
    hourly,
    daily: [],
    air: null,
  };
}

/* ================================================================== */
/* 源 5 — 7Timer! (观星 / 云量，全球)                                   */
/* ================================================================== */
async function src7Timer(lat, lon, name) {
  const res = await fetchWithTimeout(
    `https://www.7timer.info/bin/api.pl?lon=${lon}&lat=${lat}&product=civil&output=json`,
    { headers: { 'User-Agent': UA } },
    9000
  );
  if (!res.ok) throw new Error(`7timer ${res.status}`);
  const d = await res.json();
  const series = d.dataseries || [];
  if (!series.length) throw new Error('7timer empty');

  const cloudToIcon = (c) => {
    if (c <= 1) return 'clear';
    if (c <= 3) return 'mostly-clear';
    if (c <= 6) return 'partly-cloudy';
    if (c <= 8) return 'overcast';
    return 'overcast';
  };

  const first = series[0];
  const startTime = new Date();
  const hourly = series.slice(0, 8).map((s, i) => { // 3h 间隔 → 24h
    const t = new Date(startTime.getTime() + s.timepoint * 3600 * 1000);
    return {
      time: t.toISOString().slice(0, 13) + ':00',
      temp: round(s.temp2m),
      code: null,
      icon: cloudToIcon(s.cloudcover),
      pop: s.prec_amount && s.prec_amount > 0 ? 60 : 0,
      isDay: (() => {
        const h = t.getUTCHours();
        return h >= 6 && h < 18 ? 1 : 0;
      })(),
    };
  });

  const icon = cloudToIcon(first.cloudcover);

  return {
    source: '7Timer!',
    sourceNote: '云量 / 观星指数数据源',
    location: { name, lat: +lat, lon: +lon, timezone: 'auto' },
    current: {
      temp: round(first.temp2m),
      feelsLike: null,
      humidity: round(first.rh2m),
      precip: round1(first.prec_amount),
      code: null,
      icon,
      text: first.cloudcover <= 1 ? '晴' : first.cloudcover <= 3 ? '晴间多云' : first.cloudcover <= 6 ? '多云' : '阴',
      textEn: '',
      cloud: first.cloudcover * 12.5,
      pressure: round(first.pressure),
      wind: round1(first.wind10m?.speed),
      windGust: null,
      windDir: first.wind10m?.direction || '',
      windDeg: null,
      isDay: 1,
      observedAt: new Date().toISOString(),
      seeing: first.seeing,
      transparency: first.transparency,
    },
    hourly,
    daily: [],
    air: null,
  };
}

/* ================================================================== */
/* 源 6 — NWS (美国国家气象局，仅美国境内)                              */
/* ================================================================== */
async function srcNws(lat, lon, name) {
  // NWS 仅覆盖美国本土/属地，境外直接跳过（避免无谓超时）
  const inConus = lat >= 24 && lat <= 50 && lon >= -125 && lon <= -66;
  const inAlaska = lat >= 51 && lat <= 72 && lon >= -180 && lon <= -129;
  const inHawaii = lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154;
  if (!inConus && !inAlaska && !inHawaii) {
    throw new Error('nws out of coverage (US only)');
  }

  const hdr = { 'User-Agent': UA, Accept: 'application/geo+json' };
  const ptRes = await fetchWithTimeout(
    `https://api.weather.gov/points/${lat},${lon}`,
    { headers: hdr },
    9000
  );
  if (!ptRes.ok) throw new Error(`nws points ${ptRes.status}`);
  const pt = await ptRes.json();
  const forecastUrl = pt.properties?.forecast;
  const hourlyUrl = pt.properties?.forecastHourly;
  if (!forecastUrl) throw new Error('nws out of coverage');
  const resolvedName = name || pt.properties?.relativeLocation?.properties?.city || '当前位置';

  const [hRes, dRes] = await Promise.all([
    fetchWithTimeout(hourlyUrl, { headers: hdr }, 9000),
    fetchWithTimeout(forecastUrl, { headers: hdr }, 9000),
  ]);
  const hJson = hRes.ok ? await hRes.json() : null;
  const dJson = dRes.ok ? await dRes.json() : null;

  const toIcon = (t) => {
    const s = (t || '').toLowerCase();
    if (s.includes('thunder')) return 'thunder';
    if (s.includes('snow')) return 'snow';
    if (s.includes('sleet') || s.includes('freezing')) return 'sleet';
    if (s.includes('rain') || s.includes('showers')) return 'rain';
    if (s.includes('fog')) return 'fog';
    if (s.includes('partly')) return 'partly-cloudy';
    if (s.includes('cloudy') || s.includes('overcast')) return 'overcast';
    if (s.includes('sunny') || s.includes('clear')) return 'clear';
    return 'partly-cloudy';
  };

  const periods = hJson?.properties?.periods || [];
  const cur = periods[0] || {};
  const tempC = cur.temperatureUnit === 'F'
    ? (cur.temperature - 32) * 5 / 9
    : cur.temperature;

  const hourly = periods.slice(0, 24).map((p) => ({
    time: p.startTime,
    temp: round(p.temperatureUnit === 'F' ? (p.temperature - 32) * 5 / 9 : p.temperature),
    code: null,
    icon: toIcon(p.shortForecast),
    pop: round(p.probabilityOfPrecipitation?.value) ?? 0,
    isDay: p.isDaytime ? 1 : 0,
  }));

  const dayPeriods = dJson?.properties?.periods || [];
  const dayMap = new Map();
  for (const p of dayPeriods) {
    const day = p.startTime.slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, { date: day, max: null, min: null, text: p.shortForecast, icon: toIcon(p.shortForecast), pop: 0 });
    const e = dayMap.get(day);
    const t = p.temperatureUnit === 'F' ? (p.temperature - 32) * 5 / 9 : p.temperature;
    if (p.isDaytime) { e.max = round(t); e.text = p.shortForecast; e.icon = toIcon(p.shortForecast); }
    else e.min = round(t);
    e.pop = Math.max(e.pop, round(p.probabilityOfPrecipitation?.value) ?? 0);
  }
  const daily = [...dayMap.values()].slice(0, 7).map((d) => ({
    ...d, code: null, sunrise: null, sunset: null, uv: null, windMax: null,
  }));

  const curIcon = toIcon(cur.shortForecast);

  return {
    source: 'NWS',
    sourceNote: '美国国家气象局 · 官方数据',
    location: { name: resolvedName, lat: +lat, lon: +lon, timezone: 'auto' },
    current: {
      temp: round(tempC),
      feelsLike: round(cur.temperatureUnit === 'F' && cur.windChill
        ? (cur.windChill - 32) * 5 / 9
        : (cur.heatIndex ? (cur.heatIndex - 32) * 5 / 9 : null)),
      humidity: round(cur.relativeHumidity?.value),
      precip: null,
      code: null,
      icon: curIcon,
      text: cur.shortForecast || '',
      textEn: cur.shortForecast || '',
      cloud: null,
      pressure: null,
      wind: (() => {
        const m = /(\d+)/.exec(cur.windSpeed || '');
        return m ? round(parseFloat(m[1]) * 1.60934) : null;
      })(),
      windGust: null,
      windDir: cur.windDirection || '',
      windDeg: null,
      isDay: cur.isDaytime ? 1 : 0,
      observedAt: cur.startTime,
    },
    hourly,
    daily,
    air: null,
  };
}

/* ================================================================== */
/* 空气质量 — Open-Meteo Air Quality (独立端点，失败静默降级)            */
/* ================================================================== */
async function fetchAir(lat, lon) {
  try {
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      current: 'pm2_5,pm10,us_aqi,european_aqi,ozone,nitrogen_dioxide',
      timezone: 'auto',
    });
    const res = await fetchWithTimeout(
      `https://air-quality-api.open-meteo.com/v1/air-quality?${params}`,
      {},
      6000
    );
    if (!res.ok) return null;
    const d = await res.json();
    const c = d.current || {};
    const aqi = c.us_aqi;
    let level = '未知';
    if (Number.isFinite(aqi)) {
      if (aqi <= 50) level = '优';
      else if (aqi <= 100) level = '良';
      else if (aqi <= 150) level = '轻度污染';
      else if (aqi <= 200) level = '中度污染';
      else if (aqi <= 300) level = '重度污染';
      else level = '严重污染';
    }
    return {
      aqi: round(aqi),
      euAqi: round(c.european_aqi),
      level,
      pm25: round(c.pm2_5),
      pm10: round(c.pm10),
      o3: round(c.ozone),
      no2: round(c.nitrogen_dioxide),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 源注册表 — 按优先级排列                                              */
/* ------------------------------------------------------------------ */
const FORECAST_SOURCES = [
  { id: 'open-meteo', label: 'Open-Meteo', fn: srcOpenMeteo, region: 'global', timeout: 8000 },
  { id: 'met-no',     label: 'MET Norway', fn: srcMetNo,     region: 'global', timeout: 9000 },
  { id: 'wttr',       label: 'wttr.in',    fn: srcWttr,      region: 'global', timeout: 10000 },
  { id: 'brightsky',  label: 'Bright Sky (DWD)', fn: srcBrightSky, region: 'global', timeout: 9000 },
  { id: '7timer',     label: '7Timer!',    fn: src7Timer,    region: 'global', timeout: 9000 },
  { id: 'nws',        label: 'NWS',        fn: srcNws,       region: 'us',     timeout: 9000 },
];

/* ================================================================== */
/* 城市搜索 — Open-Meteo Geocoding                                      */
/* ================================================================== */
async function geocode(q) {
  const params = new URLSearchParams({
    name: q, count: '8', language: 'zh', format: 'json',
  });
  const res = await fetchWithTimeout(
    `https://geocoding-api.open-meteo.com/v1/search?${params}`,
    {},
    7000
  );
  if (!res.ok) return [];
  const d = await res.json();
  return (d.results || []).map((r) => ({
    name: r.name,
    admin1: r.admin1 || '',
    country: r.country || '',
    countryCode: r.country_code || '',
    lat: r.latitude,
    lon: r.longitude,
    timezone: r.timezone || '',
    population: r.population || 0,
  }));
}

/* ================================================================== */
/* IP 定位                                                             */
/* ================================================================== */
async function locateByIp(request) {
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const cf = request.cf || null;

  if (cf && cf.latitude) {
    return {
      lat: parseFloat(cf.latitude),
      lon: parseFloat(cf.longitude),
      city: cf.city || '',
      country: cf.country || '',
      source: 'cloudflare-edge',
    };
  }

  if (ip) {
    try {
      const res = await fetchWithTimeout(
        `http://ip-api.com/json/${ip}?fields=status,city,country,countryCode,lat,lon&lang=zh-CN`,
        {},
        5000
      );
      if (res.ok) {
        const d = await res.json();
        if (d.status === 'success') {
          return { lat: d.lat, lon: d.lon, city: d.city, country: d.country, source: 'ip-api' };
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}

/* ================================================================== */
/* 聚合入口 — 带 source 参数时强制指定源                                 */
/* ================================================================== */
async function aggregate(lat, lon, name, forceSource) {
  const errors = [];
  const list = forceSource
    ? FORECAST_SOURCES.filter((s) => s.id === forceSource)
    : FORECAST_SOURCES;

  // 指定了不存在的源：明确报错，避免返回空 detail 让人无从排查
  if (forceSource && list.length === 0) {
    return {
      ok: false,
      badSource: true,
      errors: [{
        source: forceSource,
        error: 'unknown source',
        available: FORECAST_SOURCES.map((s) => s.id),
      }],
    };
  }

  for (const s of list) {
    try {
      const data = await Promise.race([
        s.fn(lat, lon, name),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), s.timeout)),
      ]);
      if (!data || !data.current || data.current.temp === null) {
        throw new Error('empty payload');
      }
      return { ok: true, data, errors, fallbackFrom: errors.map((e) => e.source) };
    } catch (e) {
      errors.push({ source: s.label, error: String(e.message || e) });
    }
  }
  return { ok: false, errors };
}

/* ================================================================== */
/* 路由                                                                */
/* ================================================================== */
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    /* ---- /api/search?q= ---- */
    if (path === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ error: 'missing q' }, 400);
      if (q.length > 60) return json({ error: 'query too long' }, 400);
      const results = await geocode(q);
      return json({ query: q, count: results.length, results });
    }

    /* ---- /api/locate ---- */
    if (path === '/api/locate') {
      const loc = await locateByIp(request);
      if (!loc) return json({ error: 'location unavailable' }, 404);
      return json(loc);
    }

    /* ---- /api/sources ---- */
    if (path === '/api/sources') {
      return json({
        forecast: FORECAST_SOURCES.map((s) => ({
          id: s.id, label: s.label, region: s.region, priority: FORECAST_SOURCES.indexOf(s) + 1,
        })),
        air: [{ id: 'open-meteo-aq', label: 'Open-Meteo Air Quality' }],
        geocode: [{ id: 'open-meteo-geocoding', label: 'Open-Meteo Geocoding' }],
        locate: [{ id: 'cf-edge', label: 'Cloudflare Edge' }, { id: 'ip-api', label: 'ip-api.com' }],
      });
    }

    /* ---- /api/weather ---- */
    if (path === '/api/weather') {
      const lat = url.searchParams.get('lat');
      const lon = url.searchParams.get('lon');
      const name = (url.searchParams.get('name') || '').slice(0, 80);
      const force = url.searchParams.get('source') || null;

      if (!lat || !lon) return json({ error: 'missing lat/lon' }, 400);
      const la = parseFloat(lat), lo = parseFloat(lon);
      if (!Number.isFinite(la) || !Number.isFinite(lo) ||
          la < -90 || la > 90 || lo < -180 || lo > 180) {
        return json({ error: 'invalid coordinates' }, 400);
      }

      const [agg, air] = await Promise.all([
        aggregate(la, lo, name, force),
        force ? Promise.resolve(null) : fetchAir(la, lo),
      ]);

      if (!agg.ok) {
        const isBadSource = agg.badSource === true;
        return json({
          error: isBadSource ? 'unknown source' : 'all sources failed',
          detail: agg.errors,
        }, isBadSource ? 400 : 502);
      }

      const data = agg.data;
      if (data.air === null) data.air = air;
      data.meta = {
        generatedAt: new Date().toISOString(),
        degraded: agg.fallbackFrom.length > 0,
        fallbackFrom: agg.fallbackFrom,
        availableSources: FORECAST_SOURCES.map((s) => s.id),
      };
      return json(data, 200, {
        'X-Weather-Source': data.source,
        'X-Weather-Degraded': String(data.meta.degraded),
      });
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: 'internal error', message: String(e.message || e) }, 500);
  }
}
