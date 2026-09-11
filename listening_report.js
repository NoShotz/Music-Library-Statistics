const LOCAL_UTC_OFFSET_HOURS = -4; // Eastern (adjust if needed)

let SCROBBLES = null;      // raw scrobbles from lastfm_data.json
let ENRICHED = null;       // scrobbles + derived local-date fields, sorted ascending
let LIBRARY = null;        // null until library_data.json loads successfully
let COUNTRY_BY_ARTIST = null;   // normArtist -> country string ("England; United Kingdom")
let TRACK_META = null;          // "normArtist|||normTrack" -> {year, length_sec, album}
let GLOBAL_FIRST = null;   // {firstArtist, firstAlbum, firstTrack} -> earliest ENRICHED record
let PERIOD_INDEXES = null; // {year:[...], month:[...], week:[...]} continuous, ascending

const CHART_REFS = {};     // holds Chart.js instances so we can destroy/recreate on re-render

const STATE = { reportType: 'year', reportKey: null };

async function boot(){
  // 1. Load the raw, unmodified Last.fm export -- required
  let raw;
  try {
    const res = await fetch('./lastfm_data.json', {cache:'no-store'});
    if(!res.ok) throw new Error('HTTP ' + res.status);
    raw = await res.json();
    if(!raw.scrobbles || !Array.isArray(raw.scrobbles)) throw new Error('unexpected shape: missing scrobbles[]');
  } catch(err){
    console.error('Failed to load lastfm_data.json', err);
    document.getElementById('loadError').style.display = 'block';
    return;
  }
  SCROBBLES = raw.scrobbles;
  document.getElementById('mainWrap').style.display = 'block';
  document.getElementById('heroUser').textContent = raw.username || '';

  // 2. Try to load the library metadata (artist country, release year, track length) -- optional
  try {
    const res2 = await fetch('./library_data.json', {cache:'no-store'});
    if(res2.ok){
      LIBRARY = await res2.json();
      buildLibraryLookups();
    }
  } catch(err){
    console.log('library_data.json not found yet; country/hours/decade stats hidden.', err);
  }

  ENRICHED = enrich(SCROBBLES);
  GLOBAL_FIRST = buildGlobalFirstSeen(ENRICHED);
  PERIOD_INDEXES = buildPeriodIndexes(ENRICHED);

  renderOverview();
  initTabs();
  initReportControls();
  renderReport();
}

function buildLibraryLookups(){
  COUNTRY_BY_ARTIST = {};
  TRACK_META = {};
  if(!LIBRARY || !Array.isArray(LIBRARY.artists)) return;
  LIBRARY.artists.forEach(a=>{
    COUNTRY_BY_ARTIST[normArtist(a.artist)] = a.artistCountry;
    (a.albums||[]).forEach(al=>{
      (al.tracks||[]).forEach(t=>{
        const key = normArtist(a.artist) + '|||' + normTrack(t.title);
        TRACK_META[key] = {
          year: al.year,
          length_sec: parseLength(t.length),
          album: al.album
        };
      });
    });
  });
}

function parseLength(str){
  if(!str) return null;
  const parts = String(str).split(':').map(Number);
  if(parts.some(isNaN)) return null;
  return parts.reduce((acc,v)=>acc*60+v, 0);
}

// ---------- normalization / date helpers ----------
function normArtist(s){
  return String(s).toLowerCase()
    .replace(/&/g,'and')
    .replace(/[^a-z0-9 ]/g,'')
    .replace(/\s+/g,' ')
    .trim()
    .replace(/^the /,'');
}
function normTrack(s){
  return String(s).toLowerCase()
    .replace(/&/g,'and')
    .replace(/[^a-z0-9 ]/g,'')
    .replace(/\s+/g,' ')
    .trim();
}
function normAlbum(s){
  return normTrack(s);
}

function localDate(ms){
  return new Date(ms + LOCAL_UTC_OFFSET_HOURS*3600*1000);
}
function ymd(d){
  return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
}
function fmtNum(n){ return n.toLocaleString(); }
function fmtDateNice(dateStr){
  if(!dateStr) return '—';
  const d = new Date(dateStr+'T00:00:00Z');
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
function fmtHour(h){
  const hh = (h%12===0?12:h%12);
  return hh+':00'+(h<12?'am':'pm');
}
function fmtDuration(totalSeconds){
  if(totalSeconds==null) return '—';
  const totalMin = Math.round(totalSeconds/60);
  const days = Math.floor(totalMin/1440);
  const hours = Math.floor((totalMin%1440)/60);
  const mins = totalMin%60;
  const parts = [];
  if(days) parts.push(days+'d');
  if(hours||days) parts.push(hours+'h');
  parts.push(mins+'m');
  return parts.join(' ');
}
function isLeapYear(y){ return (y%4===0 && y%100!==0) || y%400===0; }
function mondayOf(dateStr){
  const d = new Date(dateStr+'T00:00:00Z');
  const dow = d.getUTCDay(); // 0 Sun..6 Sat
  const diff = (dow+6)%7;    // days since Monday
  d.setUTCDate(d.getUTCDate()-diff);
  return ymd(d);
}
function mondayIndex(dowSun0){ return (dowSun0+6)%7; } // Sun=0..Sat=6 -> Mon=0..Sun=6

// ---------- enrichment ----------
function enrich(scrobbles){
  return scrobbles.map(r=>{
    const ld = localDate(r.date);
    const dateStr = ymd(ld);
    const year = ld.getUTCFullYear();
    const month = ld.getUTCMonth()+1;
    const monthKey = year+'-'+String(month).padStart(2,'0');
    return {
      artist: r.artist, track: r.track, album: r.album, date: r.date,
      dateStr, year, monthKey, weekStart: mondayOf(dateStr),
      hour: ld.getUTCHours(), dowSun0: ld.getUTCDay(),
      na: normArtist(r.artist), nt: normTrack(r.track), nal: normAlbum(r.album)
    };
  }).sort((a,b)=>a.date-b.date);
}

function buildGlobalFirstSeen(enriched){
  const firstArtist={}, firstAlbum={}, firstTrack={};
  enriched.forEach(r=>{
    if(!(r.artist in firstArtist)) firstArtist[r.artist]=r;
    const aKey = r.artist+'|||'+r.album;
    if(!(aKey in firstAlbum)) firstAlbum[aKey]=r;
    const tKey = r.artist+'|||'+r.track;
    if(!(tKey in firstTrack)) firstTrack[tKey]=r;
  });
  return {firstArtist, firstAlbum, firstTrack};
}

// ---------- period indexing ----------
function buildPeriodIndexes(enriched){
  const firstYear = enriched[0].year, lastYear = enriched[enriched.length-1].year;
  const allYears = [];
  for(let y=firstYear;y<=lastYear;y++) allYears.push(String(y));

  const allMonths = [];
  let [my,mm] = enriched[0].monthKey.split('-').map(Number);
  const [ly,lm] = enriched[enriched.length-1].monthKey.split('-').map(Number);
  while(my<ly || (my===ly && mm<=lm)){
    allMonths.push(my+'-'+String(mm).padStart(2,'0'));
    mm++; if(mm>12){ mm=1; my++; }
  }

  const allWeeks = [];
  let wd = new Date(enriched[0].weekStart+'T00:00:00Z');
  const lastWd = new Date(enriched[enriched.length-1].weekStart+'T00:00:00Z');
  while(wd<=lastWd){
    allWeeks.push(ymd(wd));
    wd = new Date(wd.getTime()+7*86400000);
  }

  return {year:allYears, month:allMonths, week:allWeeks};
}

function periodLabel(type, key){
  if(type==='year') return key;
  if(type==='month'){
    const [y,m] = key.split('-').map(Number);
    const names=['January','February','March','April','May','June','July','August','September','October','November','December'];
    return names[m-1]+' '+y;
  }
  if(type==='week'){
    const start = new Date(key+'T00:00:00Z');
    const end = new Date(start.getTime()+6*86400000);
    const fmt = d => d.toLocaleDateString('en-US',{month:'short',day:'numeric'},{timeZone:'UTC'});
    return fmt(start)+' – '+fmt(end)+', '+end.getUTCFullYear();
  }
}

function periodDayCount(type, key){
  if(type==='year'){ const y=Number(key); return isLeapYear(y)?366:365; }
  if(type==='month'){ const [y,m]=key.split('-').map(Number); return new Date(Date.UTC(y,m,0)).getUTCDate(); }
  return 7;
}

function scrobblesInPeriod(enriched, type, key){
  if(!key) return [];
  if(type==='year') return enriched.filter(r=>String(r.year)===key);
  if(type==='month') return enriched.filter(r=>r.monthKey===key);
  return enriched.filter(r=>r.weekStart===key);
}

function prevPeriodKey(type, key){
  if(type==='year') return String(Number(key)-1);
  if(type==='month'){
    let [y,m] = key.split('-').map(Number);
    m--; if(m<1){ m=12; y--; }
    return y+'-'+String(m).padStart(2,'0');
  }
  const d = new Date(key+'T00:00:00Z');
  d.setUTCDate(d.getUTCDate()-7);
  return ymd(d);
}

// ---------- shared aggregation building blocks ----------
function topN(scrobbles, keyFn, n, mapFn){
  const counts = {};
  scrobbles.forEach(r=>{ const k=keyFn(r); counts[k]=(counts[k]||0)+1; });
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([k,c])=>mapFn(k,c));
}

function weekdayPattern(scrobbles){
  const arr = Array(7).fill(0);
  scrobbles.forEach(r=>{ arr[mondayIndex(r.dowSun0)]++; });
  return arr; // index 0=Mon .. 6=Sun
}

function hourPattern(scrobbles){
  const arr = Array(24).fill(0);
  scrobbles.forEach(r=>{ arr[r.hour]++; });
  return arr;
}

function streakStats(scrobbles){
  const dateSet = new Set(scrobbles.map(r=>r.dateStr));
  const sorted = Array.from(dateSet).sort();
  let longest = sorted.length?1:0, cur=1;
  for(let i=1;i<sorted.length;i++){
    const prev = new Date(sorted[i-1]+'T00:00:00Z');
    const curD = new Date(sorted[i]+'T00:00:00Z');
    const diff = Math.round((curD-prev)/86400000);
    cur = (diff===1) ? cur+1 : 1;
    if(cur>longest) longest = cur;
  }
  return {activeDays: dateSet.size, longestStreak: longest};
}

function busiestDay(scrobbles){
  const counts = {};
  scrobbles.forEach(r=>{ counts[r.dateStr]=(counts[r.dateStr]||0)+1; });
  let best=null;
  Object.entries(counts).forEach(([d,c])=>{ if(!best||c>best[1]) best=[d,c]; });
  return best ? {date:best[0], count:best[1]} : null;
}

function busiestHour(hourArr){
  let bi=0;
  for(let i=1;i<24;i++) if(hourArr[i]>hourArr[bi]) bi=i;
  return {hour:bi, count:hourArr[bi]};
}

function averageKnownLength(){
  if(!TRACK_META) return 0;
  const lens = Object.values(TRACK_META).map(m=>m.length_sec).filter(Boolean);
  if(!lens.length) return 0;
  return lens.reduce((a,b)=>a+b,0)/lens.length;
}

function totalSecondsFor(scrobbles){
  if(!TRACK_META) return null;
  const avgFallback = averageKnownLength();
  let total = 0;
  scrobbles.forEach(r=>{
    const meta = TRACK_META[r.na+'|||'+r.nt];
    total += (meta && meta.length_sec) ? meta.length_sec : avgFallback;
  });
  return total;
}

// country of an artist, taken as the first (most specific) semicolon-separated segment
function primaryCountry(countryStr){
  return countryStr.split(';')[0].trim();
}

// Canadian-content stats for a set of scrobbles -- lifetime %, match rate, etc.
function canadianStatsFor(scrobbles){
  if(!COUNTRY_BY_ARTIST) return null;
  let matched=0, canCount=0;
  scrobbles.forEach(r=>{
    const country = COUNTRY_BY_ARTIST[r.na];
    if(country===undefined) return;
    matched++;
    if(/canada/i.test(country)) canCount++;
  });
  return {
    matched, total: scrobbles.length,
    matchRate: scrobbles.length ? matched/scrobbles.length*100 : 0,
    pct: matched ? Math.round(canCount/matched*1000)/10 : null
  };
}

// Canadian-content % by year, for the year-over-year trend chart on the Overview tab
function canadianYearlyFor(scrobbles){
  if(!COUNTRY_BY_ARTIST) return null;
  const yearTotal={}, yearCan={};
  scrobbles.forEach(r=>{
    const country = COUNTRY_BY_ARTIST[r.na];
    if(country===undefined) return;
    yearTotal[r.year] = (yearTotal[r.year]||0)+1;
    if(/canada/i.test(country)) yearCan[r.year] = (yearCan[r.year]||0)+1;
  });
  return Object.keys(yearTotal).map(Number).sort((a,b)=>a-b).map(y=>({
    year:y, pct: Math.round((yearCan[y]||0)/yearTotal[y]*1000)/10
  }));
}

function countryRowsFor(scrobbles){
  if(!COUNTRY_BY_ARTIST) return null;
  const totals = {}, byArtist = {};
  scrobbles.forEach(r=>{
    const country = COUNTRY_BY_ARTIST[r.na];
    if(country===undefined) return;
    const c = primaryCountry(country);
    totals[c] = (totals[c]||0)+1;
    byArtist[c] = byArtist[c] || {};
    byArtist[c][r.artist] = (byArtist[c][r.artist]||0)+1;
  });
  return Object.keys(totals).map(country=>{
    const top = Object.entries(byArtist[country]).sort((a,b)=>b[1]-a[1])[0];
    return {country, count: totals[country], topArtist: top[0], topArtistCount: top[1]};
  }).sort((a,b)=>b.count-a.count);
}

function decadeRowsFor(scrobbles){
  if(!TRACK_META) return null;
  const counts = {};
  scrobbles.forEach(r=>{
    const meta = TRACK_META[r.na+'|||'+r.nt];
    if(meta && meta.year){
      const dec = Math.floor(meta.year/10)*10;
      counts[dec] = (counts[dec]||0)+1;
    }
  });
  return Object.keys(counts).map(Number).sort((a,b)=>a-b).map(dec=>({decade:dec, count:counts[dec]}));
}

function computeNew(scrobbles, type, periodType, periodKey){
  const firstMap = type==='artist' ? GLOBAL_FIRST.firstArtist
                  : type==='album'  ? GLOBAL_FIRST.firstAlbum
                  : GLOBAL_FIRST.firstTrack;
  const keyFn = type==='artist' ? r=>r.artist
              : type==='album'  ? r=>r.artist+'|||'+r.album
              : r=>r.artist+'|||'+r.track;
  const fieldName = periodType==='year' ? 'year' : periodType==='month' ? 'monthKey' : 'weekStart';
  const matchVal = periodType==='year' ? Number(periodKey) : periodKey;

  const counts = {};
  scrobbles.forEach(r=>{ const k=keyFn(r); counts[k]=(counts[k]||0)+1; });
  const uniqueKeys = Object.keys(counts);
  const newKeys = uniqueKeys.filter(k=>{
    const first = firstMap[k];
    return first && first[fieldName]===matchVal;
  });
  let topNew = null;
  newKeys.forEach(k=>{ if(!topNew || counts[k]>counts[topNew]) topNew=k; });

  return {
    uniqueCount: uniqueKeys.length,
    newCount: newKeys.length,
    newPct: uniqueKeys.length ? Math.round(newKeys.length/uniqueKeys.length*1000)/10 : 0,
    topNew: topNew ? {key:topNew, count:counts[topNew]} : null
  };
}

function computeStats(scrobbles, periodType, periodKey){
  const weekday = weekdayPattern(scrobbles);
  const hourArr = hourPattern(scrobbles);
  const {activeDays, longestStreak} = streakStats(scrobbles);
  return {
    n: scrobbles.length,
    weekday, hourArr,
    activeDays, longestStreak,
    busiestDay: busiestDay(scrobbles),
    busiestHour: busiestHour(hourArr),
    totalSeconds: totalSecondsFor(scrobbles),
    topArtists: topN(scrobbles, r=>r.artist, 5, (k,c)=>({artist:k,count:c})),
    topAlbums: topN(scrobbles, r=>r.artist+'|||'+r.album, 5, (k,c)=>{ const [artist,album]=k.split('|||'); return {artist,album,count:c}; }),
    topTracks: topN(scrobbles, r=>r.artist+'|||'+r.track, 5, (k,c)=>{ const [artist,track]=k.split('|||'); return {artist,track,count:c}; }),
    newArtists: computeNew(scrobbles,'artist',periodType,periodKey),
    newAlbums: computeNew(scrobbles,'album',periodType,periodKey),
    newTracks: computeNew(scrobbles,'track',periodType,periodKey),
    firstScrobble: scrobbles.length ? scrobbles[0] : null,
    countryRows: countryRowsFor(scrobbles),
    canadian: canadianStatsFor(scrobbles),
    decades: decadeRowsFor(scrobbles)
  };
}

function subPeriodBreakdown(type, curScrobbles, curKey, prevScrobbles, prevKey){
  if(type==='year'){
    const labels=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const cur=Array(12).fill(0), prev=Array(12).fill(0);
    curScrobbles.forEach(r=>{ cur[Number(r.monthKey.split('-')[1])-1]++; });
    prevScrobbles.forEach(r=>{ prev[Number(r.monthKey.split('-')[1])-1]++; });
    return {labels, cur, prev};
  }
  if(type==='month'){
    const days = periodDayCount('month', curKey);
    const cur = Array(days).fill(0), prev = Array(days).fill(0);
    curScrobbles.forEach(r=>{ const d=Number(r.dateStr.split('-')[2]); if(d-1<days) cur[d-1]++; });
    prevScrobbles.forEach(r=>{ const d=Number(r.dateStr.split('-')[2]); if(d-1<days) prev[d-1]++; });
    const labels = Array.from({length:days},(_,i)=>String(i+1));
    return {labels, cur, prev};
  }
  const labels=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  return {labels, cur: weekdayPattern(curScrobbles), prev: weekdayPattern(prevScrobbles)};
}

// percentage-point difference between two already-percentage values (e.g. 32% -> 38% is "+6.0pp")
function ppChange(curPct, prevPct){
  if(prevPct==null || curPct==null) return {label:'—', cls:''};
  const diff = Math.round((curPct-prevPct)*10)/10;
  const sign = diff>0 ? '+' : '';
  return {label: sign+diff+'pp', cls: diff>0?'up':(diff<0?'down':'')};
}

function pctChange(curVal, prevVal){
  if(prevVal===0) return curVal>0 ? {label:'new', cls:'up'} : {label:'—', cls:''};
  const p = Math.round((curVal-prevVal)/prevVal*1000)/10;
  const sign = p>0 ? '+' : '';
  return {label: sign+p+'%', cls: p>0?'up':(p<0?'down':'')};
}

// ============================================================
// OVERVIEW TAB
// ============================================================
function renderOverview(){
  const s = ENRICHED;
  const n = s.length;
  const firstMs = s[0].date, lastMs = s[n-1].date;
  const spanDays = Math.round((lastMs-firstMs)/86400000);

  const stats = computeStats(s, 'year', String(s[0].year)); // periodType/key unused for new% at all-time scale but harmless
  // all-time "new" doesn't mean much, so recompute unique counts / top lists directly instead:
  const artistCounts = {};
  s.forEach(r=>{ artistCounts[r.artist] = (artistCounts[r.artist]||0)+1; });
  const uniqueArtists = Object.keys(artistCounts).length;

  const topArtists = topN(s, r=>r.artist, 10, (k,c)=>({artist:k,count:c}));
  const topTracks = topN(s, r=>r.artist+'|||'+r.track, 10, (k,c)=>{ const [artist,track]=k.split('|||'); return {artist,track,count:c}; });
  const topAlbums = topN(s, r=>r.artist+'|||'+r.album, 10, (k,c)=>{ const [artist,album]=k.split('|||'); return {artist,album,count:c}; });

  const yearCounts = {};
  s.forEach(r=>{ yearCounts[r.year] = (yearCounts[r.year]||0)+1; });
  const yearly = Object.keys(yearCounts).map(Number).sort((a,b)=>a-b).map(y=>({year:y,count:yearCounts[y]}));

  const hourOfDay = hourPattern(s).map((count,hour)=>({hour,count}));
  const dowOrder = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const weekdayArr = weekdayPattern(s);
  const dayOfWeek = dowOrder.map((d,i)=>({day:d, count:weekdayArr[i]}));

  const discoveryByYear = {};
  Object.values(GLOBAL_FIRST.firstArtist).forEach(r=>{ discoveryByYear[r.year] = (discoveryByYear[r.year]||0)+1; });
  const discovery = Object.keys(discoveryByYear).map(Number).sort((a,b)=>a-b).map(y=>({year:y,count:discoveryByYear[y]}));

  const {activeDays, longestStreak} = streakStats(s);

  const totalHours = TRACK_META ? Math.round(totalSecondsFor(s)/3600*10)/10 : null;
  const countryRows = countryRowsFor(s);
  const decade = TRACK_META ? decadeRowsFor(s).filter(d=>d.count>5) : null;

  let canData = null;
  if(COUNTRY_BY_ARTIST){
    const canLifetime = canadianStatsFor(s);
    const cutoff30 = lastMs - 30*86400000;
    const canRecent = canadianStatsFor(s.filter(r=>r.date>=cutoff30));
    const yearlyCanadian = canadianYearlyFor(s);
    canData = {
      lifetimePct: canLifetime.pct, matchRate: canLifetime.matchRate,
      recentPct: canRecent.pct, yearlyCanadian
    };
  }

  paintOverview({
    total_scrobbles:n, unique_artists:uniqueArtists, first_date: ymd(new Date(firstMs)),
    last_date: ymd(new Date(lastMs)), span_days: spanDays, active_days: activeDays,
    longest_streak: longestStreak, yearly, top_artists: topArtists, top_tracks: topTracks,
    top_albums: topAlbums, hour_of_day: hourOfDay, day_of_week: dayOfWeek, discovery,
    country_rows: countryRows, total_hours: totalHours, decade, can: canData
  });
}

function paintOverview(DATA){
  Chart.defaults.color = '#a4937f';
  Chart.defaults.font.family = "'Work Sans', sans-serif";
  Chart.defaults.font.size = 11.5;
  Chart.defaults.borderColor = '#3a2f24';

  const GOLD = '#d6a24c';
  const GOLD_DIM = 'rgba(214,162,76,0.35)';
  const TEAL = '#5a9a94';
  const TEAL_DIM = 'rgba(90,154,148,0.35)';
  const COUNTRY_PALETTE = ['#d6a24c','#5a9a94','#c0392b','#8a6c3a','#7a9ec9','#a76fc9','#c98f5a','#6c9a5a'];

  document.getElementById('heroScrobbles').textContent = fmtNum(DATA.total_scrobbles);
  const years = (DATA.span_days/365.25).toFixed(1);
  document.getElementById('heroSpan').textContent = years + ' years';
  document.getElementById('heroDates').textContent = DATA.first_date + ' to ' + DATA.last_date;

  const heroHoursEl = document.getElementById('heroHours');
  const heroEyebrow = heroHoursEl.nextElementSibling;
  if(DATA.total_hours != null){
    heroHoursEl.textContent = fmtNum(Math.round(DATA.total_hours));
  } else {
    heroHoursEl.textContent = fmtNum(DATA.total_scrobbles);
    if(heroEyebrow) heroEyebrow.textContent = 'scrobbles logged';
  }

  const topCountry = DATA.country_rows && DATA.country_rows.length ? DATA.country_rows[0] : null;
  const stats = [
    [fmtNum(DATA.total_scrobbles), 'total scrobbles'],
    [DATA.unique_artists, 'unique artists'],
    [DATA.active_days, 'active listening days'],
    [DATA.longest_streak + 'd', 'longest streak'],
  ];
  if(DATA.can){
    stats.push([DATA.can.lifetimePct!=null ? DATA.can.lifetimePct+'%' : '—', 'lifetime Canadian']);
    stats.push([DATA.can.recentPct!=null ? DATA.can.recentPct+'%' : '—', 'last 30 days Canadian']);
  }
  if(topCountry){
    const pct = Math.round(topCountry.count/DATA.total_scrobbles*1000)/10;
    stats.push([topCountry.country, 'top artist country (' + pct + '%)']);
    stats.push([DATA.country_rows.length, 'countries represented']);
  }
  document.getElementById('statGrid').innerHTML = stats.map(s =>
    `<div class="stat-card"><div class="stat-val">${s[0]}</div><div class="stat-lbl">${s[1]}</div></div>`
  ).join('');

  document.getElementById('factStreak').textContent = DATA.longest_streak;
  document.getElementById('factArtists').textContent = DATA.unique_artists;
  document.getElementById('factActive').textContent = Math.round(DATA.active_days/DATA.span_days*100) + '%';
  const top10sum = DATA.top_artists.slice(0,10).reduce((a,b)=>a+b.count,0);
  document.getElementById('factTop10').textContent = Math.round(top10sum/DATA.total_scrobbles*100) + '%';

  new Chart(document.getElementById('yearChart'), {
    type:'bar',
    data:{ labels: DATA.yearly.map(d=>d.year),
      datasets:[{ data: DATA.yearly.map(d=>d.count), backgroundColor: GOLD_DIM, borderRadius:2, barPercentage:0.7 }] },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: c => c.parsed.y.toLocaleString()+' scrobbles' } } },
      scales:{ x:{ grid:{display:false} }, y:{ grid:{color:'#241d16'}, ticks:{ callback: v => v>=1000? (v/1000)+'k': v } } } }
  });

  // Canadian content, year over year
  if(DATA.can && DATA.can.yearlyCanadian && DATA.can.yearlyCanadian.length){
    document.getElementById('canChartCard').style.display = 'block';
    new Chart(document.getElementById('canChart'), {
      type:'line',
      data:{ labels: DATA.can.yearlyCanadian.map(d=>d.year),
        datasets:[
          { data: DATA.can.yearlyCanadian.map(d=>d.pct), borderColor: '#c0392b', backgroundColor:'rgba(192,57,43,0.12)', fill:true, tension:0.3, pointRadius:3, pointBackgroundColor: '#c0392b' },
          { data: DATA.can.yearlyCanadian.map(()=>35), borderColor:'#5a6a5a', borderDash:[4,4], pointRadius:0, borderWidth:1 }
        ]},
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: c => c.datasetIndex===0 ? c.parsed.y+'% Canadian' : '35% target' } } },
        scales:{ x:{ grid:{display:false} }, y:{ grid:{color:'#241d16'}, ticks:{ callback: v=>v+'%' }, suggestedMax:40 } } }
    });
    const co = document.getElementById('canCallout');
    co.style.display = 'block';
    co.innerHTML = `Lifetime average sits at <b>${DATA.can.lifetimePct}%</b> Canadian (matched ${DATA.can.matchRate.toFixed(1)}% of scrobbles to a known artist country). Last 30 days: <b>${DATA.can.recentPct!=null ? DATA.can.recentPct+'%' : '—'}</b>.`;
  }

  // Top countries -- replaces the old Canada-only chart
  if(DATA.country_rows && DATA.country_rows.length){
    document.getElementById('countryChartCard').style.display = 'block';
    document.getElementById('countryListCard').style.display = 'block';
    const top8 = DATA.country_rows.slice(0,8);
    new Chart(document.getElementById('countryChart'), {
      type:'bar',
      data:{ labels: top8.map(d=>d.country),
        datasets:[{ data: top8.map(d=>d.count), backgroundColor: top8.map((_,i)=>COUNTRY_PALETTE[i%COUNTRY_PALETTE.length]), borderRadius:2, barPercentage:0.65 }] },
      options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: c => c.parsed.x.toLocaleString()+' scrobbles' } } },
        scales:{ x:{ grid:{color:'#241d16'} }, y:{ grid:{display:false} } } }
    });
    document.getElementById('countryTopList').innerHTML = top8.map((c,i)=>`
      <li>
        <span class="rank-num">${String(i+1).padStart(2,'0')}</span>
        <div class="rank-main">
          <div class="rank-title">${c.country}</div>
          <div class="rank-sub">top artist: ${c.topArtist}</div>
        </div>
        <span class="rank-count">${fmtNum(c.count)}</span>
      </li>`).join('');
    document.getElementById('countryPendingNotice').style.display = 'none';
  } else {
    document.getElementById('countryPendingNotice').style.display = 'block';
  }

  if(DATA.decade && DATA.decade.length){
    document.getElementById('decadeChartCard').style.display = 'block';
    new Chart(document.getElementById('decadeChart'), {
      type:'bar',
      data:{ labels: DATA.decade.map(d=>d.decade+'s'),
        datasets:[{ data: DATA.decade.map(d=>d.count), backgroundColor: GOLD, borderRadius:2, barPercentage:0.65 }] },
      options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: c => c.parsed.x.toLocaleString()+' scrobbles' } } },
        scales:{ x:{ grid:{color:'#241d16'} }, y:{ grid:{display:false} } } }
    });
  }

  function renderList(elId, items, mainFn, subFn){
    document.getElementById(elId).innerHTML = items.map((it,i)=>`
      <li>
        <span class="rank-num">${String(i+1).padStart(2,'0')}</span>
        <div class="rank-main">
          <div class="rank-title">${mainFn(it)}</div>
          ${subFn(it) ? `<div class="rank-sub">${subFn(it)}</div>` : ''}
        </div>
        <span class="rank-count">${fmtNum(it.count)}</span>
      </li>`).join('');
  }
  renderList('artistList', DATA.top_artists, d=>d.artist, d=>'');
  renderList('trackList', DATA.top_tracks, d=>d.track, d=>d.artist);
  renderList('albumList', DATA.top_albums, d=>d.album, d=>d.artist);

  new Chart(document.getElementById('hourChart'), {
    type:'bar',
    data:{ labels: DATA.hour_of_day.map(d=> (d.hour%12===0?12:d.hour%12) + (d.hour<12?'a':'p')),
      datasets:[{ data: DATA.hour_of_day.map(d=>d.count), backgroundColor: TEAL_DIM, borderRadius:2 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false} },
      scales:{ x:{ grid:{display:false}, ticks:{ maxRotation:0, autoSkip:true, maxTicksLimit:8 } }, y:{ grid:{color:'#241d16'} } } }
  });

  new Chart(document.getElementById('dowChart'), {
    type:'bar',
    data:{ labels: DATA.day_of_week.map(d=>d.day.slice(0,3)),
      datasets:[{ data: DATA.day_of_week.map(d=>d.count), backgroundColor: TEAL, borderRadius:3, barPercentage:0.6 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false} },
      scales:{ x:{ grid:{display:false} }, y:{ grid:{color:'#241d16'} } } }
  });

  new Chart(document.getElementById('discoveryChart'), {
    type:'bar',
    data:{ labels: DATA.discovery.map(d=>d.year),
      datasets:[{ data: DATA.discovery.map(d=>d.count), backgroundColor: GOLD_DIM, borderRadius:2, barPercentage:0.7 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false} },
      scales:{ x:{ grid:{display:false} }, y:{ grid:{color:'#241d16'} } } }
  });
}

// ============================================================
// TABS
// ============================================================
function initTabs(){
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const tab = btn.dataset.tab;
      document.getElementById('tab-overview').style.display = tab==='overview' ? 'block' : 'none';
      document.getElementById('tab-report').style.display = tab==='report' ? 'block' : 'none';
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b===btn));
    });
  });
}

// ============================================================
// REPORT TAB
// ============================================================
function initReportControls(){
  STATE.reportType = 'year';
  STATE.reportKey = PERIOD_INDEXES.year[PERIOD_INDEXES.year.length-1];

  document.querySelectorAll('.seg-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.seg-btn').forEach(b=>b.classList.toggle('active', b===btn));
      STATE.reportType = btn.dataset.type;
      const list = PERIOD_INDEXES[STATE.reportType];
      STATE.reportKey = list[list.length-1];
      populatePeriodSelect();
      renderReport();
    });
  });

  document.getElementById('periodSelect').addEventListener('change', e=>{
    STATE.reportKey = e.target.value;
    renderReport();
  });

  document.getElementById('periodPrev').addEventListener('click', ()=>{
    const list = PERIOD_INDEXES[STATE.reportType];
    const i = list.indexOf(STATE.reportKey);
    if(i>0){ STATE.reportKey = list[i-1]; document.getElementById('periodSelect').value = STATE.reportKey; renderReport(); }
  });
  document.getElementById('periodNext').addEventListener('click', ()=>{
    const list = PERIOD_INDEXES[STATE.reportType];
    const i = list.indexOf(STATE.reportKey);
    if(i>=0 && i<list.length-1){ STATE.reportKey = list[i+1]; document.getElementById('periodSelect').value = STATE.reportKey; renderReport(); }
  });

  populatePeriodSelect();
}

function populatePeriodSelect(){
  const sel = document.getElementById('periodSelect');
  const list = PERIOD_INDEXES[STATE.reportType];
  sel.innerHTML = list.map(k=>`<option value="${k}">${periodLabel(STATE.reportType,k)}</option>`).join('');
  sel.value = STATE.reportKey;
}

function destroyChart(key){
  if(CHART_REFS[key]){ CHART_REFS[key].destroy(); CHART_REFS[key]=null; }
}

function renderReport(){
  const type = STATE.reportType, key = STATE.reportKey;
  const list = PERIOD_INDEXES[type];
  const idx = list.indexOf(key);
  document.getElementById('periodPrev').disabled = idx<=0;
  document.getElementById('periodNext').disabled = idx>=list.length-1;

  const curScrobbles = scrobblesInPeriod(ENRICHED, type, key);
  const prevKey = prevPeriodKey(type, key);
  const prevScrobbles = scrobblesInPeriod(ENRICHED, type, prevKey);

  const cur = computeStats(curScrobbles, type, key);
  const prev = computeStats(prevScrobbles, type, prevKey);

  if(cur.n===0){
    document.getElementById('reportEmpty').style.display = 'block';
    document.getElementById('reportBody').style.display = 'none';
    return;
  }
  document.getElementById('reportEmpty').style.display = 'none';
  document.getElementById('reportBody').style.display = 'block';

  // ---- main stat grid ----
  const uniqueArtistsCur = cur.newArtists.uniqueCount, uniqueArtistsPrev = prev.newArtists.uniqueCount;
  const uniqueAlbumsCur = cur.newAlbums.uniqueCount, uniqueAlbumsPrev = prev.newAlbums.uniqueCount;
  const uniqueTracksCur = cur.newTracks.uniqueCount, uniqueTracksPrev = prev.newTracks.uniqueCount;

  const scrobCmp = pctChange(cur.n, prev.n);
  const artCmp = pctChange(uniqueArtistsCur, uniqueArtistsPrev);
  const albCmp = pctChange(uniqueAlbumsCur, uniqueAlbumsPrev);
  const trkCmp = pctChange(uniqueTracksCur, uniqueTracksPrev);

  const statCards = [
    [fmtNum(cur.n), 'scrobbles', scrobCmp],
    [fmtNum(uniqueArtistsCur), 'artists', artCmp],
    [fmtNum(uniqueAlbumsCur), 'albums', albCmp],
    [fmtNum(uniqueTracksCur), 'tracks', trkCmp],
  ];
  if(cur.canadian && cur.canadian.pct!=null){
    const canCmp = ppChange(cur.canadian.pct, prev.canadian && prev.canadian.pct);
    statCards.push([cur.canadian.pct+'%', 'Canadian', canCmp]);
  }
  document.getElementById('reportStatGrid').innerHTML = statCards.map(s=>`
    <div class="stat-card"><div class="stat-val">${s[0]}<span class="cmp ${s[2].cls}">${s[2].label}</span></div><div class="stat-lbl">${s[1]} · vs. ${periodLabel(type,prevKey)}</div></div>
  `).join('');

  // ---- sub-period chart ----
  const sub = subPeriodBreakdown(type, curScrobbles, key, prevScrobbles, prevKey);
  document.getElementById('subPeriodTitle').textContent =
    type==='year' ? 'Scrobbles per month' : type==='month' ? 'Scrobbles per day' : 'Scrobbles per day';
  document.getElementById('subPeriodDesc').textContent =
    periodLabel(type,key) + ' vs. ' + periodLabel(type,prevKey);
  destroyChart('sub');
  CHART_REFS.sub = new Chart(document.getElementById('subPeriodChart'), {
    type:'bar',
    data:{ labels: sub.labels, datasets:[
      { label: periodLabel(type,key), data: sub.cur, backgroundColor:'#d6a24c', borderRadius:2, barPercentage:0.7 },
      { label: periodLabel(type,prevKey), data: sub.prev, backgroundColor:'rgba(122,108,92,0.35)', borderRadius:2, barPercentage:0.7 }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:true, labels:{boxWidth:10}}, tooltip:{mode:'index', intersect:false} },
      scales:{ x:{ grid:{display:false}, ticks:{ maxRotation:0, autoSkip:true, maxTicksLimit: type==='month'?15:12 } }, y:{ grid:{color:'#241d16'} } } }
  });

  // ---- top lists + new stats ----
  function renderRankedList(elId, items, mainFn, subFn){
    document.getElementById(elId).innerHTML = items.map((it,i)=>`
      <li>
        <span class="rank-num">${String(i+1).padStart(2,'0')}</span>
        <div class="rank-main">
          <div class="rank-title">${mainFn(it)}</div>
          ${subFn(it) ? `<div class="rank-sub">${subFn(it)}</div>` : ''}
        </div>
        <span class="rank-count">${fmtNum(it.count)}</span>
      </li>`).join('');
  }
  renderRankedList('reportArtistList', cur.topArtists, d=>d.artist, ()=>'');
  renderRankedList('reportTrackList', cur.topTracks, d=>d.track, d=>d.artist);
  renderRankedList('reportAlbumList', cur.topAlbums, d=>d.album, d=>d.artist);

  document.getElementById('reportArtistsDesc').textContent =
    `${cur.newArtists.newPct}% new this period` + (cur.newArtists.topNew ? ` · top new: ${cur.newArtists.topNew.key}` : '');
  document.getElementById('reportTracksDesc').textContent =
    `${cur.newTracks.newPct}% new this period` + (cur.newTracks.topNew ? ` · top new: ${cur.newTracks.topNew.key.split('|||')[1]}` : '');
  document.getElementById('reportAlbumsDesc').textContent =
    `${cur.newAlbums.newPct}% new this period` + (cur.newAlbums.topNew ? ` · top new: ${cur.newAlbums.topNew.key.split('|||')[1]}` : '');

  const first = cur.firstScrobble;
  document.getElementById('firstTrackCallout').innerHTML = first
    ? `First scrobble of this period: <b>${first.track}</b> by <b>${first.artist}</b> on ${fmtDateNice(first.dateStr)}.`
    : '';

  // ---- day of week (cur vs prev) ----
  const dowLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  destroyChart('dow');
  CHART_REFS.dow = new Chart(document.getElementById('reportDowChart'), {
    type:'bar',
    data:{ labels: dowLabels, datasets:[
      { label: periodLabel(type,key), data: cur.weekday, backgroundColor:'#5a9a94', borderRadius:2, barPercentage:0.6 },
      { label: periodLabel(type,prevKey), data: prev.weekday, backgroundColor:'rgba(90,154,148,0.3)', borderRadius:2, barPercentage:0.6 }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:true, labels:{boxWidth:10}} },
      scales:{ x:{ grid:{display:false} }, y:{ grid:{color:'#241d16'} } } }
  });

  // ---- listening clock (cur only) ----
  destroyChart('hour');
  CHART_REFS.hour = new Chart(document.getElementById('reportHourChart'), {
    type:'bar',
    data:{ labels: cur.hourArr.map((_,h)=> (h%12===0?12:h%12) + (h<12?'a':'p')),
      datasets:[{ data: cur.hourArr, backgroundColor:'rgba(90,154,148,0.35)', borderRadius:2 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false} },
      scales:{ x:{ grid:{display:false}, ticks:{ maxRotation:0, autoSkip:true, maxTicksLimit:8 } }, y:{ grid:{color:'#241d16'} } } }
  });

  // ---- artist map (country breakdown) ----
  if(cur.countryRows && cur.countryRows.length){
    document.getElementById('reportCountryCard').style.display = 'block';
    document.getElementById('reportCountryPending').style.display = 'none';
    document.getElementById('reportCountryList').innerHTML = cur.countryRows.map((c,i)=>`
      <li>
        <span class="rank-num">${String(i+1).padStart(2,'0')}</span>
        <div class="rank-main">
          <div class="rank-title">${c.country}</div>
          <div class="rank-sub">top artist: ${c.topArtist}</div>
        </div>
        <span class="rank-count">${fmtNum(c.count)}</span>
      </li>`).join('');
  } else {
    document.getElementById('reportCountryCard').style.display = 'none';
    document.getElementById('reportCountryPending').style.display = TRACK_META ? 'none' : 'block';
  }

  // ---- Canadian content, this period vs. previous ----
  if(cur.canadian && cur.canadian.pct!=null){
    const co = document.getElementById('reportCanCallout');
    co.style.display = 'block';
    const prevBit = (prev.canadian && prev.canadian.pct!=null) ? ` Previous period: <b>${prev.canadian.pct}%</b>.` : '';
    co.innerHTML = `<b>${cur.canadian.pct}%</b> Canadian this period (matched ${cur.canadian.matchRate.toFixed(1)}% of scrobbles to a known artist country).${prevBit}`;
  } else {
    document.getElementById('reportCanCallout').style.display = 'none';
  }

  // ---- decade breakdown ----
  if(cur.decades && cur.decades.length){
    document.getElementById('reportDecadeCard').style.display = 'block';
    destroyChart('decade');
    CHART_REFS.decade = new Chart(document.getElementById('reportDecadeChart'), {
      type:'bar',
      data:{ labels: cur.decades.map(d=>d.decade+'s'),
        datasets:[{ data: cur.decades.map(d=>d.count), backgroundColor:'#d6a24c', borderRadius:2, barPercentage:0.65 }] },
      options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: c => c.parsed.x.toLocaleString()+' scrobbles' } } },
        scales:{ x:{ grid:{color:'#241d16'} }, y:{ grid:{display:false} } } }
    });
  } else {
    document.getElementById('reportDecadeCard').style.display = 'none';
  }

  // ---- quick facts ----
  const hoursCmp = (cur.totalSeconds!=null && prev.totalSeconds!=null) ? pctChange(cur.totalSeconds, prev.totalSeconds) : null;
  const avgPerDay = Math.round(cur.n/periodDayCount(type,key)*10)/10;
  const facts = [
    [fmtDuration(cur.totalSeconds), 'listening time' + (hoursCmp ? ` <span class="cmp ${hoursCmp.cls}">${hoursCmp.label}</span>` : '')],
    [avgPerDay, 'avg scrobbles / day'],
    [cur.longestStreak + 'd', 'longest streak in this period'],
    [cur.busiestDay ? fmtDateNice(cur.busiestDay.date) : '—', 'busiest day' + (cur.busiestDay?` (${cur.busiestDay.count} scrobbles)`:'')],
    [cur.busiestHour ? fmtHour(cur.busiestHour.hour) : '—', 'busiest hour' + (cur.busiestHour?` (${cur.busiestHour.count} scrobbles)`:'')],
  ];
  document.getElementById('reportFactGrid').innerHTML = facts.map(f=>
    `<div class="fact"><div class="fact-num">${f[0]}</div><div class="fact-lbl">${f[1]}</div></div>`
  ).join('');
}

boot();
