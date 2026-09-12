const LOCAL_UTC_OFFSET_HOURS = -4; // Eastern (adjust if needed)

let SCROBBLES = null;      // raw scrobbles from lastfm_data.json
let ENRICHED = null;       // scrobbles + derived local-date fields, sorted ascending
let LIBRARY = null;        // null until library_data.json loads successfully
let COUNTRY_BY_ARTIST = null;   // normArtist -> country string ("England; United Kingdom")
let TRACK_META = null;          // "normArtist|||normTrack" -> {year, length_sec, album}
let GLOBAL_FIRST = null;   // {firstArtist, firstAlbum, firstTrack} -> earliest ENRICHED record
let PERIOD_INDEXES = null; // {year:[...], month:[...], week:[...]} continuous, ascending

const CHART_REFS = {};     // holds Chart.js instances so we can destroy/recreate on re-render
const MAP_REFS = {};       // holds jsVectorMap instances so we can destroy/recreate on re-render

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

// Maps common English country names (MusicBrainz-style, including UK constituent
// countries) to ISO 3166-1 alpha-2 codes, which is what the world map's regions use.
const COUNTRY_NAME_TO_ISO2 = (() => {
  const table = {
    'Afghanistan':'AF','Albania':'AL','Algeria':'DZ','Andorra':'AD','Angola':'AO',
    'Argentina':'AR','Armenia':'AM','Australia':'AU','Austria':'AT','Azerbaijan':'AZ',
    'Bahamas':'BS','Bahrain':'BH','Bangladesh':'BD','Barbados':'BB','Belarus':'BY',
    'Belgium':'BE','Belize':'BZ','Benin':'BJ','Bhutan':'BT','Bolivia':'BO',
    'Bosnia and Herzegovina':'BA','Botswana':'BW','Brazil':'BR','Brunei':'BN',
    'Bulgaria':'BG','Burkina Faso':'BF','Burundi':'BI','Cambodia':'KH','Cameroon':'CM',
    'Canada':'CA','Cape Verde':'CV','Cabo Verde':'CV','Central African Republic':'CF',
    'Chad':'TD','Chile':'CL','China':'CN','Colombia':'CO','Comoros':'KM',
    'Congo':'CG','Republic of the Congo':'CG','Democratic Republic of the Congo':'CD',
    'DR Congo':'CD','Costa Rica':'CR','Croatia':'HR','Cuba':'CU','Cyprus':'CY',
    'Czech Republic':'CZ','Czechia':'CZ','Denmark':'DK','Djibouti':'DJ','Dominica':'DM',
    'Dominican Republic':'DO','Ecuador':'EC','Egypt':'EG','El Salvador':'SV',
    'England':'GB','Equatorial Guinea':'GQ','Eritrea':'ER','Estonia':'EE',
    'Eswatini':'SZ','Swaziland':'SZ','Ethiopia':'ET','Fiji':'FJ','Finland':'FI',
    'France':'FR','Gabon':'GA','Gambia':'GM','Georgia':'GE','Germany':'DE',
    'Ghana':'GH','Greece':'GR','Grenada':'GD','Guatemala':'GT','Guinea':'GN',
    'Guinea-Bissau':'GW','Guyana':'GY','Haiti':'HT','Honduras':'HN','Hong Kong':'HK',
    'Hungary':'HU','Iceland':'IS','India':'IN','Indonesia':'ID','Iran':'IR',
    'Iraq':'IQ','Ireland':'IE','Israel':'IL','Italy':'IT','Ivory Coast':'CI',
    "Cote d'Ivoire":'CI','Jamaica':'JM','Japan':'JP','Jordan':'JO','Kazakhstan':'KZ',
    'Kenya':'KE','Kiribati':'KI','Kosovo':'XK','Kuwait':'KW','Kyrgyzstan':'KG',
    'Laos':'LA','Latvia':'LV','Lebanon':'LB','Lesotho':'LS','Liberia':'LR',
    'Libya':'LY','Liechtenstein':'LI','Lithuania':'LT','Luxembourg':'LU',
    'Madagascar':'MG','Malawi':'MW','Malaysia':'MY','Maldives':'MV','Mali':'ML',
    'Malta':'MT','Mauritania':'MR','Mauritius':'MU','Mexico':'MX','Micronesia':'FM',
    'Moldova':'MD','Monaco':'MC','Mongolia':'MN','Montenegro':'ME','Morocco':'MA',
    'Mozambique':'MZ','Myanmar':'MM','Burma':'MM','Namibia':'NA','Nauru':'NR',
    'Nepal':'NP','Netherlands':'NL','New Zealand':'NZ','Nicaragua':'NI','Niger':'NE',
    'Nigeria':'NG','North Korea':'KP','North Macedonia':'MK','Macedonia':'MK',
    'Northern Ireland':'GB','Norway':'NO','Oman':'OM','Pakistan':'PK','Palau':'PW',
    'Palestine':'PS','Panama':'PA','Papua New Guinea':'PG','Paraguay':'PY',
    'Peru':'PE','Philippines':'PH','Poland':'PL','Portugal':'PT','Puerto Rico':'PR',
    'Qatar':'QA','Romania':'RO','Russia':'RU','Russian Federation':'RU','Rwanda':'RW',
    'Saint Lucia':'LC','Samoa':'WS','San Marino':'SM','Saudi Arabia':'SA',
    'Scotland':'GB','Senegal':'SN','Serbia':'RS','Seychelles':'SC','Sierra Leone':'SL',
    'Singapore':'SG','Slovakia':'SK','Slovenia':'SI','Solomon Islands':'SB',
    'Somalia':'SO','South Africa':'ZA','South Korea':'KR','Korea, South':'KR',
    'South Sudan':'SS','Spain':'ES','Sri Lanka':'LK','Sudan':'SD','Suriname':'SR',
    'Sweden':'SE','Switzerland':'CH','Syria':'SY','Taiwan':'TW','Tajikistan':'TJ',
    'Tanzania':'TZ','Thailand':'TH','Timor-Leste':'TL','Togo':'TG','Tonga':'TO',
    'Trinidad and Tobago':'TT','Tunisia':'TN','Turkey':'TR','Turkmenistan':'TM',
    'Tuvalu':'TV','Uganda':'UG','Ukraine':'UA','United Arab Emirates':'AE',
    'United Kingdom':'GB','UK':'GB','Great Britain':'GB',
    'United States':'US','United States of America':'US','USA':'US','U.S.A.':'US',
    'Uruguay':'UY','Uzbekistan':'UZ','Vanuatu':'VU','Vatican City':'VA',
    'Holy See':'VA','Venezuela':'VE','Vietnam':'VN','Viet Nam':'VN','Wales':'GB',
    'Yemen':'YE','Zambia':'ZM','Zimbabwe':'ZW'
  };
  const lower = {};
  Object.keys(table).forEach(k => { lower[k.toLowerCase()] = table[k]; });
  return lower;
})();

// Canonical display name per ISO2 code, for when several country strings
// (e.g. "England", "Scotland", "United Kingdom") collapse onto the same map region.
const ISO2_TO_DISPLAY_NAME = {
  GB:'United Kingdom', US:'United States', CG:'Republic of the Congo',
  CD:'Democratic Republic of the Congo', CZ:'Czechia', CI:"Cote d'Ivoire",
  KR:'South Korea', KP:'North Korea', MK:'North Macedonia', SZ:'Eswatini',
  MM:'Myanmar', RU:'Russia', VA:'Vatican City', VN:'Vietnam'
};

function isoForCountry(name){
  if(!name) return null;
  return COUNTRY_NAME_TO_ISO2[name.trim().toLowerCase()] || null;
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
  const totals = {}, byArtist = {}, displayName = {};
  scrobbles.forEach(r=>{
    const country = COUNTRY_BY_ARTIST[r.na];
    if(country===undefined) return;
    const primary = primaryCountry(country);
    const iso = isoForCountry(primary);
    // group by ISO2 code when we recognize the name (so "England"/"Scotland"/
    // "United Kingdom" all collapse into one map region); otherwise fall back
    // to the raw name so unrecognized countries still show up in stats/lists.
    const key = iso || primary;
    totals[key] = (totals[key]||0)+1;
    byArtist[key] = byArtist[key] || {};
    byArtist[key][r.artist] = (byArtist[key][r.artist]||0)+1;
    displayName[key] = iso ? (ISO2_TO_DISPLAY_NAME[iso] || primary) : primary;
  });
  return Object.keys(totals).map(key=>{
    const top = Object.entries(byArtist[key]).sort((a,b)=>b[1]-a[1])[0];
    return {
      country: displayName[key], iso: isoForCountry(displayName[key]),
      count: totals[key], topArtist: top[0], topArtistCount: top[1]
    };
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

  const newItems = newKeys.map(k=>({key:k, count:counts[k]})).sort((a,b)=>b.count-a.count);

  return {
    uniqueCount: uniqueKeys.length,
    newCount: newKeys.length,
    newPct: uniqueKeys.length ? Math.round(newKeys.length/uniqueKeys.length*1000)/10 : 0,
    topNew: topNew ? {key:topNew, count:counts[topNew]} : null,
    newItems
  };
}

// turns computeNew()'s flat "artist|||thing" keyed newItems into display-ready rows
function discoveryRows(newResult, type){
  return newResult.newItems.map(it=>{
    if(type==='artist') return {artist:it.key, count:it.count};
    const [artist, rest] = it.key.split('|||');
    return type==='album' ? {artist, album:rest, count:it.count} : {artist, track:rest, count:it.count};
  });
}

function computeStats(scrobbles, periodType, periodKey){
  const weekday = weekdayPattern(scrobbles);
  const hourArr = hourPattern(scrobbles);
  const {activeDays, longestStreak} = streakStats(scrobbles);
  const newArtists = computeNew(scrobbles,'artist',periodType,periodKey);
  const newAlbums = computeNew(scrobbles,'album',periodType,periodKey);
  const newTracks = computeNew(scrobbles,'track',periodType,periodKey);
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
    newArtists, newAlbums, newTracks,
    discoveries: {
      artists: discoveryRows(newArtists,'artist'),
      albums: discoveryRows(newAlbums,'album'),
      tracks: discoveryRows(newTracks,'track')
    },
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
  return {label: sign+diff+'%', cls: diff>0?'up':(diff<0?'down':'')};
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

  const topArtists = topN(s, r=>r.artist, 5, (k,c)=>({artist:k,count:c}));
  const topTracks = topN(s, r=>r.artist+'|||'+r.track, 5, (k,c)=>{ const [artist,track]=k.split('|||'); return {artist,track,count:c}; });
  const topAlbums = topN(s, r=>r.artist+'|||'+r.album, 5, (k,c)=>{ const [artist,album]=k.split('|||'); return {artist,album,count:c}; });

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
    document.getElementById('countryMapCard').style.display = 'block';
    renderCountryMap('countryMap', 'overview', DATA.country_rows, DATA.total_scrobbles);
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
          <div class="rank-sub">${subFn(it) || '&nbsp;'}</div>
        </div>
        <span class="rank-count">${fmtNum(it.count)}</span>
      </li>`).join('');
  }
  renderList('artistList', DATA.top_artists, d=>d.artist, d=>'');
  renderList('trackList', DATA.top_tracks, d=>d.track, d=>d.artist);
  renderList('albumList', DATA.top_albums, d=>d.album, d=>d.artist);

  new Chart(document.getElementById('hourChart'), {
    type:'bar',
    data:{ labels: DATA.hour_of_day.map(d=> (d.hour%12===0?12:d.hour%12) + (d.hour<12?'AM':'PM')),
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

      if(tab==='report'){
        // The Report tab (and its map) is first built at boot while this tab is
        // still display:none, so jsVectorMap measures a zero-height container
        // and renders cut off. updateSize() alone doesn't fully recover from
        // that bad initial measurement -- a full re-render (which recreates the
        // map from scratch against the now-visible container) does, and it's
        // exactly what already happens whenever the period selector changes,
        // which is why switching year/month/week "fixes" it. So just do the
        // same thing when the tab itself is switched into view.
        renderReport();
      } else if(MAP_REFS['overview']){
        MAP_REFS['overview'].updateSize();
      }
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

// ---- manual color scale (see renderCountryMap comment for why this is
// computed by hand instead of handed to jsvectormap's built-in scale/
// normalizeFunction) ----
const MAP_COLOR_LOW = [0x5c,0x4a,0x30];   // #5c4a30
const MAP_COLOR_HIGH = [0xd6,0xa2,0x4c];  // #d6a24c
const MAP_BUCKET_COUNT = 10;

function lerpColor(t){
  const c = MAP_COLOR_LOW.map((lo,i)=>Math.round(lo + (MAP_COLOR_HIGH[i]-lo)*t));
  return '#' + c.map(v=>v.toString(16).padStart(2,'0')).join('');
}

// Renders a hoverable world map into #containerId, keyed on ISO2 country codes.
// countryRows: [{country, iso, count, topArtist, topArtistCount}], from countryRowsFor().
function renderCountryMap(containerId, refKey, countryRows, totalScrobbles){
  // jsvectormap has a known bug where re-initializing a map on a container
  // that already held one (e.g. switching year -> month -> week on the
  // Report tab) can leave the old SVG behind (duplicate map) and miscompute
  // its color scale on the new instance (regions render black/inverted).
  // destroy() alone isn't reliable against this, so we also force-clear the
  // container's DOM ourselves before creating the next instance.
  if(MAP_REFS[refKey]){
    try { MAP_REFS[refKey].destroy(); } catch(e){ /* ignore -- clearing DOM below is what actually matters */ }
    MAP_REFS[refKey] = null;
  }
  const el = document.getElementById(containerId);
  if(!el) return;
  el.innerHTML = '';

  const withIso = (countryRows||[]).filter(c=>c.iso);
  if(!withIso.length) return;

  // Precompute each country's fill color ourselves (log scale, since one or
  // two countries -- e.g. the US -- usually dwarf everything else) and hand
  // jsvectormap a discrete color bucket per region rather than raw counts.
  // This sidesteps its internal min/max/scale computation entirely, which is
  // the actual source of the black/inverted coloring bug.
  const counts = withIso.map(c=>c.count);
  const min = Math.min(...counts), max = Math.max(...counts);
  const logMin = Math.log(min+1), logMax = Math.log(max+1);
  const span = logMax - logMin;

  const scale = {};
  for(let i=0;i<MAP_BUCKET_COUNT;i++){
    scale['b'+i] = lerpColor(i/(MAP_BUCKET_COUNT-1));
  }

  const values = {}, meta = {};
  withIso.forEach(c=>{
    const t = span>0 ? (Math.log(c.count+1)-logMin)/span : 1;
    const bucket = Math.min(MAP_BUCKET_COUNT-1, Math.round(t*(MAP_BUCKET_COUNT-1)));
    values[c.iso] = 'b'+bucket;
    meta[c.iso] = c;
  });

  MAP_REFS[refKey] = new jsVectorMap({
    selector: '#'+containerId,
    map: 'world',
    backgroundColor: 'transparent',
    zoomButtons: false,
    zoomOnScroll: false,
    showTooltip: true,
    regionStyle: {
      initial: { fill:'#332a1f', fillOpacity:1, stroke:'#15110d', strokeWidth:0.6 },
      hover: { fillOpacity:1, cursor:'pointer' }
    },
    series: {
      regions: [{
        attribute: 'fill',
        values,
        scale
      }]
    },
    onRegionTooltipShow(event, tooltip, code){
      const m = meta[code];
      if(!m) return; // no scrobbles matched to this country -- fall back to default tooltip
      const pct = totalScrobbles ? Math.round(m.count/totalScrobbles*1000)/10 : null;
      tooltip.text(
        `<div style="font-weight:600;margin-bottom:2px;">${m.country}</div>` +
        `<div>${fmtNum(m.count)} scrobbles${pct!=null ? ' ('+pct+'%)' : ''}</div>` +
        `<div style="opacity:0.75;">top artist: ${m.topArtist}</div>`,
        true
      );
    }
  });
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
  function renderRankedList(elId, items, mainFn, subFn, emptyMsg){
    if(!items.length && emptyMsg){
      document.getElementById(elId).innerHTML = `
        <li>
          <span class="rank-num">&nbsp;</span>
          <div class="rank-main">
            <div class="rank-title" style="color:var(--muted-2);">${emptyMsg}</div>
            <div class="rank-sub">&nbsp;</div>
          </div>
          <span class="rank-count">&nbsp;</span>
        </li>`;
      return;
    }
    document.getElementById(elId).innerHTML = items.map((it,i)=>`
      <li>
        <span class="rank-num">${String(i+1).padStart(2,'0')}</span>
        <div class="rank-main">
          <div class="rank-title">${mainFn(it)}</div>
          <div class="rank-sub">${subFn(it) || '&nbsp;'}</div>
        </div>
        <span class="rank-count">${fmtNum(it.count)}</span>
      </li>`).join('');
  }
  renderRankedList('reportArtistList', cur.topArtists, d=>d.artist, ()=>'');
  renderRankedList('reportTrackList', cur.topTracks, d=>d.track, d=>d.artist);
  renderRankedList('reportAlbumList', cur.topAlbums, d=>d.album, d=>d.artist);

  // ---- discoveries: full lists of new artists/albums/tracks this period ----
  const DISCOVERY_LIMIT = 5;
  renderRankedList('reportNewArtistList', cur.discoveries.artists.slice(0,DISCOVERY_LIMIT), d=>d.artist, ()=>'', 'No new artists discovered this period.');
  renderRankedList('reportNewTrackList', cur.discoveries.tracks.slice(0,DISCOVERY_LIMIT), d=>d.track, d=>d.artist, 'No new tracks discovered this period.');
  renderRankedList('reportNewAlbumList', cur.discoveries.albums.slice(0,DISCOVERY_LIMIT), d=>d.album, d=>d.artist, 'No new albums discovered this period.');

  document.getElementById('reportNewArtistsDesc').textContent =
    `${fmtNum(cur.newArtists.newCount)} new artist${cur.newArtists.newCount===1?'':'s'} this period` +
    (cur.discoveries.artists.length>DISCOVERY_LIMIT ? ` · showing top ${DISCOVERY_LIMIT} by plays` : '');
  document.getElementById('reportNewTracksDesc').textContent =
    `${fmtNum(cur.newTracks.newCount)} new track${cur.newTracks.newCount===1?'':'s'} this period` +
    (cur.discoveries.tracks.length>DISCOVERY_LIMIT ? ` · showing top ${DISCOVERY_LIMIT} by plays` : '');
  document.getElementById('reportNewAlbumsDesc').textContent =
    `${fmtNum(cur.newAlbums.newCount)} new album${cur.newAlbums.newCount===1?'':'s'} this period` +
    (cur.discoveries.albums.length>DISCOVERY_LIMIT ? ` · showing top ${DISCOVERY_LIMIT} by plays` : '');

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
    data:{ labels: cur.hourArr.map((_,h)=> (h%12===0?12:h%12) + (h<12?'AM':'PM')),
      datasets:[{ data: cur.hourArr, backgroundColor:'rgba(90,154,148,0.35)', borderRadius:2 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false} },
      scales:{ x:{ grid:{display:false}, ticks:{ maxRotation:0, autoSkip:true, maxTicksLimit:8 } }, y:{ grid:{color:'#241d16'} } } }
  });

  // ---- artist map (country breakdown) ----
  if(cur.countryRows && cur.countryRows.length){
    document.getElementById('reportCountryCard').style.display = 'block';
    document.getElementById('reportCountryPending').style.display = 'none';
    renderCountryMap('reportCountryMap', 'report', cur.countryRows, cur.n);
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
